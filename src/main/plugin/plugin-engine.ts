import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { net } from 'electron';
import { findCachedNpxBin, clearCachedNpxPackage } from '../utils/npx-resolve';
import { Client } from '@modelcontextprotocol/sdk/client/index';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import type { ToolRegistry } from '../agent/tool-registry';
import type {
  PluginConfig,
  PluginInstance,
  MCPConnection,
  LogEntry,
  PluginToolInfo,
  PluginStatusInfo,
} from './types';
import { loadSettings, saveSettings } from '../settings';
import { getLocalDataDir } from '../paths';
import { ensureSkillFiles, getPromptText, writeSkillPrompt } from '../skill/skill-file';
import { loadLocalConfig } from '../local-config';

declare const __API_BASE_URL__: string;
const API_BASE_URL = typeof __API_BASE_URL__ !== 'undefined' ? __API_BASE_URL__ : '';

const MAX_LOG_ENTRIES = 500;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [5000, 10000, 20000];

export class PluginEngine {
  private plugins = new Map<string, PluginInstance>();

  constructor(private toolRegistry: ToolRegistry) {}

  async setToolRegistry(newRegistry: ToolRegistry): Promise<void> {
    this.toolRegistry = newRegistry;
    const activePlugins = Array.from(this.plugins.entries())
      .filter(([_, inst]) => inst.status === 'active' && inst.mcpConnection)
      .map(([id]) => id);

    for (const pluginId of activePlugins) {
      const inst = this.plugins.get(pluginId)!;
      const conn = inst.mcpConnection!;
      try {
        const toolsResult = await conn.client.listTools();
        const tools = toolsResult.tools || [];
        for (const tool of tools) {
          this.registerMCPTool(pluginId, conn, tool);
        }
        console.log(`[PluginEngine] Re-registered ${tools.length} tools for "${pluginId}"`);
      } catch (err) {
        console.warn(`[PluginEngine] Failed to re-register tools for "${pluginId}":`, err);
      }
    }
  }

  async enable(pluginId: string): Promise<void> {
    const settings = loadSettings();
    const config = (settings.plugins || []).find(p => p.id === pluginId);
    if (!config) throw new Error(`Plugin "${pluginId}" not found in settings`);
    // Don't throw if disabled — just skip. This prevents autoStartAll from
    // failing due to race conditions where settings change between the
    // autoStartAll filter and this enable() call.
    if (!config.enabled) return;

    if (this.plugins.has(pluginId)) {
      await this.disable(pluginId);
    }

    const instance: PluginInstance = {
      config,
      status: 'active',
      tools: [],
      logs: [],
    };

    if (config.mcp) {
      const tryConnect = async (): Promise<void> => {
        const conn = await this.startMCPConnection(pluginId, config);
        instance.mcpConnection = conn;

        const toolsResult = await conn.client.listTools();
        const tools = toolsResult.tools || [];
        instance.tools = tools.map((t: any) => ({
          name: t.name,
          description: t.description || t.name,
          parameters: (t.inputSchema as Record<string, any>) || {},
        }));

        for (const tool of tools) {
          this.registerMCPTool(pluginId, conn, tool);
        }

        this.addLog(pluginId, 'event', `Started — ${tools.length} tools discovered`);

        conn.transport.onclose = () => {
          if (!conn.manualStop) console.warn(`[PluginEngine] Plugin "${pluginId}" transport closed, reconnecting...`);
          instance.status = 'stopped';
          this.addLog(pluginId, 'event', 'Transport closed');
          this.toolRegistry.unregisterByPlugin(pluginId);
          if (!conn.manualStop) {
            this.scheduleReconnect(pluginId);
          }
        };

        conn.transport.onerror = (err: any) => {
          console.error(`[PluginEngine] Plugin "${pluginId}" error:`, err);
          instance.status = 'error';
          instance.error = String(err);
          this.addLog(pluginId, 'error', `Transport error: ${err}`);
          this.toolRegistry.unregisterByPlugin(pluginId);
          if (!conn.manualStop) {
            this.scheduleReconnect(pluginId);
          }
        };

        const toolNames = tools.map((t: any) => t.name).join(', ');
        console.log(`[PluginEngine] Enabled "${pluginId}" — ${tools.length} tools: ${toolNames}`);
      };

      try {
        await tryConnect();
      } catch (firstErr) {
        // For npx-based plugins, clear cache and retry once. A cached copy
        // can be broken (partial install, missing bundled deps) — then every
        // subsequent start fails the same way. Always clear to force a fresh
        // download on retry, regardless of whether the first attempt used
        // direct-exec or went through npx.
        if (config.mcp.command === 'npx') {
          const pkgName = this.getNpxPackageName(config.mcp.args);
          if (pkgName) {
            const removed = this.clearNpxCacheFor(pkgName);
            this.addLog(pluginId, 'event', `First start failed, cleared ${removed} npx cache entr${removed === 1 ? 'y' : 'ies'} for "${pkgName}" and retrying...`);
            console.log(`[PluginEngine] "${pluginId}" failed, cleared ${removed} cache entries for "${pkgName}" and retrying...`);
            try {
              await tryConnect();
              // Retry succeeded — done
              this.plugins.set(pluginId, instance);
              return;
            } catch (retryErr) {
              // Retry also failed — fall through to error handling
              console.warn(`[PluginEngine] "${pluginId}" retry also failed:`, retryErr);
            }
          }
        }
        // Both attempts failed (or not npx)
        instance.status = 'error';
        instance.error = String(firstErr);
        this.addLog(pluginId, 'error', instance.error);
        this.plugins.set(pluginId, instance);
        throw new Error(instance.error);
      }
    }

    this.plugins.set(pluginId, instance);
  }

  async disable(pluginId: string): Promise<void> {
    const inst = this.plugins.get(pluginId);
    if (!inst) return;

    if (inst.mcpConnection) {
      inst.mcpConnection.manualStop = true;
      if (inst.mcpConnection.retryTimer) clearTimeout(inst.mcpConnection.retryTimer);
      this.toolRegistry.unregisterByPlugin(pluginId);
      try {
        await inst.mcpConnection.client.close();
      } catch { /* ignore close errors */ }
    }

    this.plugins.delete(pluginId);
    // Only log manual disable, not auto-reconnect cycles
    if (inst?.mcpConnection?.manualStop) console.log(`[PluginEngine] Disabled "${pluginId}"`);
  }

  async install(config: PluginConfig): Promise<void> {
    const settings = loadSettings();
    const plugins = settings.plugins || [];
    if (plugins.some(p => p.id === config.id)) {
      throw new Error(`Plugin "${config.id}" already exists`);
    }
    const normalized = ensureSkillFiles({ ...config, inject_prompt: config.inject_prompt || config.instructions });
    plugins.push(normalized);
    saveSettings({ ...settings, plugins });

    // Only auto-enable pure instruction plugins (no MCP process to fail).
    // MCP plugins are enabled by the user after verifying config.
    if (normalized.enabled && !normalized.mcp && getPromptText(normalized)) {
      try {
        await this.enable(normalized.id);
      } catch (err) {
        console.warn(`[PluginEngine] Install ok but auto-enable failed for "${normalized.id}":`, err);
      }
    }

    // 异步上报安装计数（仅 market 来源，不阻塞，失败静默）
    if (normalized.source === 'market') {
      this.recordInstall(normalized.id).catch(() => {});
    }
  }

  /**
   * 上报安装事件到后端 POST /plugins/:slug/install
   * 后端按 machine_id 去重（每机器每天 1 次），用于安装计数统计。
   */
  private async recordInstall(slug: string): Promise<void> {
    try {
      const { machineId } = loadLocalConfig();
      if (!machineId || !API_BASE_URL) return;

      const url = `${API_BASE_URL}/plugins/${encodeURIComponent(slug)}/install`;
      await new Promise<void>((resolve, reject) => {
        const request = net.request({ url, method: 'POST' });
        request.setHeader('Content-Type', 'application/json');
        const body = JSON.stringify({ machine_id: machineId });
        request.on('response', (response) => {
          // 消费 body 以释放连接
          response.on('data', () => {});
          response.on('end', () => resolve());
        });
        request.on('error', reject);
        request.write(body);
        request.end();
      });
    } catch (err) {
      // 静默失败，安装计数不影响安装流程
      console.debug(`[PluginEngine] recordInstall failed for "${slug}":`, err);
    }
  }

  async uninstall(pluginId: string): Promise<void> {
    await this.disable(pluginId);
    const settings = loadSettings();
    const plugins = (settings.plugins || []).filter(p => p.id !== pluginId);
    saveSettings({ ...settings, plugins });
  }

  async update(pluginId: string, updates: Partial<PluginConfig>): Promise<void> {
    const settings = loadSettings();
    const plugins = settings.plugins || [];
    const idx = plugins.findIndex(p => p.id === pluginId);
    if (idx === -1) throw new Error(`Plugin "${pluginId}" not found`);

    const wasActive = this.plugins.get(pluginId)?.status === 'active';
    if (wasActive) {
      await this.disable(pluginId);
    }

    const merged = { ...plugins[idx] };
    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined) continue;
      if (val === null) {
        delete (merged as any)[key];
      } else {
        (merged as any)[key] = val;
      }
    }
    if ((updates.inject_prompt !== undefined || updates.instructions !== undefined) && !merged.mcp) {
      const prompt = (updates.inject_prompt ?? updates.instructions ?? getPromptText(merged)) as string;
      Object.assign(merged, writeSkillPrompt(merged, prompt || ''));
    }
    plugins[idx] = merged;
    saveSettings({ ...settings, plugins });

    if (wasActive && merged.enabled) {
      try {
        await this.enable(pluginId);
      } catch (err) {
        console.warn(`[PluginEngine] Update ok but re-enable failed for "${pluginId}":`, err);
      }
    }
  }

  getAll(): PluginStatusInfo[] {
    const settings = loadSettings();
    const plugins = settings.plugins || [];

    return plugins.map(config => {
      const inst = this.plugins.get(config.id);
      return {
        id: config.id,
        name: config.name,
        description: config.description,
        enabled: config.enabled,
        hasInstructions: !!getPromptText(config),
        hasMCP: !!config.mcp,
        skill_path: config.skill_path,
        status: inst?.status || 'stopped',
        toolCount: inst?.tools.length || 0,
        error: inst?.error,
        source: config.source,
        sourceUri: config.sourceUri,
        version: config.version,
        page: config.page,
        serverInfo: inst?.mcpConnection?.serverInfo,
      };
    });
  }

  getTools(pluginId: string): PluginToolInfo[] {
    return this.plugins.get(pluginId)?.tools || [];
  }

  getLogs(pluginId: string): LogEntry[] {
    return this.plugins.get(pluginId)?.logs || [];
  }

  clearLogs(pluginId: string): void {
    const inst = this.plugins.get(pluginId);
    if (inst) inst.logs = [];
  }

  getServerInfo(pluginId: string): { name: string; version: string } | undefined {
    return this.plugins.get(pluginId)?.mcpConnection?.serverInfo;
  }

  async autoStartAll(): Promise<void> {
    // One-time migration: clear skill_path for text prompt plugins that were
    // incorrectly set by the old ensureSkillFiles. Only real skill packages
    // (from folder/GitHub/COS) should have skill_path. Text prompts store
    // their content in inject_prompt directly.
    this.migrateSkillPaths();

    const settings = loadSettings();
    const plugins = (settings.plugins || []).filter(p => {
      if (!p.enabled) return false;
      if (p.mcp) return p.mcp.autoStart;
      return true;
    });

    for (const plugin of plugins) {
      try {
        await this.enable(plugin.id);
      } catch (err) {
        console.warn(`[PluginEngine] Auto-start failed for "${plugin.id}":`, err);
      }
    }
  }

  /**
   * Clear skill_path for plugins that have inject_prompt set (text prompts).
   * Real skill packages from COS don't have inject_prompt, so their skill_path
   * is preserved. Folder/GitHub skills do have inject_prompt, but clearing
   * their skill_path is safe — the prompt is in inject_prompt, and SKILL.md
   * remains on disk for readSkillPrompt() if needed later.
   */
  private migrateSkillPaths(): void {
    const settings = loadSettings();
    const plugins = settings.plugins || [];
    let changedCount = 0;

    for (let i = 0; i < plugins.length; i++) {
      const p = plugins[i];
      // Clear skill_path if: has inject_prompt (text prompt) AND has skill_path AND no MCP
      if (p.inject_prompt && p.skill_path && !p.mcp) {
        console.log(`[PluginEngine] Migration: clearing skill_path for text prompt "${p.id}"`);
        plugins[i] = { ...p, skill_path: undefined };
        changedCount++;
      }
    }

    if (changedCount > 0) {
      saveSettings({ ...settings, plugins });
      console.log(`[PluginEngine] Migration: cleared skill_path for ${changedCount} text prompt plugin(s)`);
    }
  }

  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.plugins.keys());
    for (const id of ids) {
      try {
        await this.disable(id);
      } catch { /* ignore shutdown errors */ }
    }
  }

  private async startMCPConnection(pluginId: string, config: PluginConfig): Promise<MCPConnection> {
    const mcp = config.mcp!;
    const globalNodePath = this.getGlobalNodePath();
    const shellEnv = this.getShellEnv();

    // Resolve abstract command (npx/node) to actual executable
    const resolved = this.resolveCommand(mcp.command, mcp.args);

    // Merge: process.env < shell env (PATH fix) < resolved env < plugin env
    const baseEnv = { ...process.env, ...shellEnv, ...resolved.env, ...mcp.env } as Record<string, string>;
    if (globalNodePath) {
      baseEnv.NODE_PATH = [globalNodePath, process.env.NODE_PATH].filter(Boolean).join(':');
    }

    const transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: baseEnv,
      stderr: 'pipe',
    });

    // Bind stderr capture BEFORE connect so early process failures (e.g.
    // MODULE_NOT_FOUND) are logged. The SDK creates a PassThrough in the
    // transport constructor and pipes _process.stderr into it at start(),
    // so attaching here captures everything from the moment it spawns.
    const stderrStream = transport.stderr;
    if (stderrStream) {
      stderrStream.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) this.addLog(pluginId, 'error', trimmed);
        }
      });
    }

    const client = new Client(
      { name: 'deepseno', version: '1.0.0' },
      { capabilities: {} },
    );

    const timeoutMs = mcp.command === 'npx' ? 60000 : 30000;
    const connectResult = await Promise.race([
      client.connect(transport),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), timeoutMs)),
    ]);
    if (connectResult === 'timeout') {
      try { await client.close(); } catch { /* ignore */ }
      throw new Error(`Connection timed out after ${timeoutMs / 1000}s — the server process may have failed to start`);
    }

    let serverInfo: { name: string; version: string } | undefined;
    try {
      const info = (client as any).getServerVersion?.() || (client as any)._serverVersion;
      if (info) serverInfo = { name: info.name || pluginId, version: info.version || 'unknown' };
    } catch {}

    return {
      client,
      transport,
      serverInfo,
      retryCount: 0,
      retryTimer: undefined,
      manualStop: false,
    };
  }

  private registerMCPTool(pluginId: string, conn: MCPConnection, tool: any): void {
    const toolName = `plugin_${pluginId}_${tool.name}`;
    this.toolRegistry.register(
      {
        name: toolName,
        description: tool.description || tool.name,
        parameters: (tool.inputSchema as Record<string, any>) || {},
        source: 'plugin',
        pluginId,
      },
      async (params: any) => {
        this.addLog(pluginId, 'tool', `→ ${tool.name} ${JSON.stringify(params).slice(0, 200)}`);
        const callStart = Date.now();
        try {
          const result = await conn.client.callTool({ name: tool.name, arguments: params });
          const elapsed = Date.now() - callStart;
          const contentArr = (result.content as any[]) || [];
          const textContent = contentArr
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');

          // Extract image data from MCP response
          const images: Array<{ data: Buffer; mimeType: string }> = [];
          for (const c of contentArr) {
            if (c.type !== 'image') continue;
            try {
              if (c.data) {
                // base64-encoded image (e.g. Playwright screenshot)
                images.push({ data: Buffer.from(c.data, 'base64'), mimeType: c.mimeType || 'image/png' });
              } else if (c.url) {
                // URL image — download to Buffer
                const imgRes = await fetch(c.url, { signal: AbortSignal.timeout(10_000) });
                if (imgRes.ok) {
                  const contentType = imgRes.headers.get('content-type') || 'image/png';
                  const mimeType = contentType.split(';')[0].trim();
                  images.push({ data: Buffer.from(await imgRes.arrayBuffer()), mimeType });
                } else {
                  console.warn(`[PluginEngine] Failed to download image from ${c.url}: HTTP ${imgRes.status}`);
                }
              }
            } catch (imgErr) {
              console.warn(`[PluginEngine] Failed to extract image from ${tool.name}:`, imgErr);
            }
          }

          this.addLog(pluginId, 'tool', `← ${tool.name} ${elapsed}ms success${images.length ? ` +${images.length}img` : ''}`);
          return { success: true, data: textContent || result.content, images: images.length ? images : undefined };
        } catch (err) {
          const elapsed = Date.now() - callStart;
          this.addLog(pluginId, 'tool', `← ${tool.name} ${elapsed}ms error: ${err}`);
          return { success: false, error: String(err) };
        }
      },
    );
  }

  private scheduleReconnect(pluginId: string): void {
    const inst = this.plugins.get(pluginId);
    if (!inst?.mcpConnection || inst.mcpConnection.manualStop) return;
    const conn = inst.mcpConnection;
    if (conn.retryCount >= MAX_RETRIES) {
      console.error(`[PluginEngine] Giving up on "${pluginId}" after ${MAX_RETRIES} retries`);
      inst.status = 'error';
      inst.error = `Server crashed and failed to restart after ${MAX_RETRIES} attempts`;
      return;
    }
    const delay = RETRY_DELAYS[conn.retryCount] || 20000;
    // Only log reconnect on later attempts (first reconnect is usually just npx restart)
    if (conn.retryCount > 0) console.log(`[PluginEngine] Reconnecting "${pluginId}" in ${delay / 1000}s (attempt ${conn.retryCount + 1}/${MAX_RETRIES})`);
    this.addLog(pluginId, 'event', `Reconnecting in ${delay / 1000}s (attempt ${conn.retryCount + 1}/${MAX_RETRIES})`);
    conn.retryTimer = setTimeout(async () => {
      conn.retryCount++;
      try {
        await this.enable(pluginId);
        console.log(`[PluginEngine] Reconnected "${pluginId}" successfully`);
      } catch (err) {
        console.warn(`[PluginEngine] Reconnect attempt ${conn.retryCount} failed for "${pluginId}":`, err);
        this.scheduleReconnect(pluginId);
      }
    }, delay);
  }

  private addLog(pluginId: string, level: LogEntry['level'], message: string): void {
    const inst = this.plugins.get(pluginId);
    if (!inst) return;
    inst.logs.push({ timestamp: Date.now(), level, message });
    if (inst.logs.length > MAX_LOG_ENTRIES) {
      inst.logs = inst.logs.slice(-MAX_LOG_ENTRIES);
    }
  }

  /** Extract the npm package name from npx args (first arg that isn't a flag) */
  private getNpxPackageName(args: string[]): string | null {
    for (const arg of args) {
      if (!arg.startsWith('-')) return arg.replace(/@(latest|[\d.]+.*)$/, '');
    }
    return null;
  }

  /** Clear every npx cache entry containing the given package. Returns count removed. */
  private clearNpxCacheFor(pkgName: string): number {
    const removed = clearCachedNpxPackage(pkgName);
    if (removed > 0) console.log(`[PluginEngine] Cleared ${removed} npx cache entr${removed === 1 ? 'y' : 'ies'} for "${pkgName}"`);
    return removed;
  }

  // ─── Bundled Node.js runtime (ELECTRON_RUN_AS_NODE) ──────

  /**
   * Get the path to the Electron binary suitable for ELECTRON_RUN_AS_NODE.
   * On macOS, uses the Helper binary to avoid spawning Dock icons for each
   * subprocess. On other platforms, uses process.execPath directly.
   */
  private _nodeExecPath: string | undefined;
  /** True when getNodeExecPath() resolved to a real system node (not Electron/Helper). */
  private _isSystemNode = false;
  private getNodeExecPath(): string {
    if (this._nodeExecPath) return this._nodeExecPath;

    if (process.platform === 'darwin') {
      // Use "DeepSeno Helper" which doesn't create Dock icons
      const helperPath = path.join(
        path.dirname(process.execPath), '..', 'Frameworks',
        `${path.basename(process.execPath)} Helper.app`, 'Contents', 'MacOS',
        `${path.basename(process.execPath)} Helper`,
      );
      if (fs.existsSync(helperPath)) {
        this._nodeExecPath = helperPath;
        console.log(`[PluginEngine] Using Helper binary for node: ${helperPath}`);
        return helperPath;
      }
    }

    if (process.platform === 'win32') {
      // Prefer system node.exe to avoid console window from Electron's GUI exe
      try {
        const { execFileSync } = require('child_process');
        const nodePath = execFileSync('where', ['node'], { timeout: 3000, encoding: 'utf-8', windowsHide: true }).trim().split(/\r?\n/)[0].trim();
        if (nodePath && fs.existsSync(nodePath)) {
          this._nodeExecPath = nodePath;
          this._isSystemNode = true;
          console.log(`[PluginEngine] Using system node for Windows: ${nodePath}`);
          return nodePath;
        }
      } catch {}
    }

    this._nodeExecPath = process.execPath;
    return process.execPath;
  }

  /**
   * Resolve abstract commands ('npx', 'node') to the bundled runtime.
   * Uses Electron's built-in Node.js via ELECTRON_RUN_AS_NODE=1 and the
   * bundled npm module for npx. Creates a 'node' shim so npx's child
   * processes (which use #!/usr/bin/env node) can also find node.
   *
   * For npx commands: if the package is already cached, runs the bin entry
   * directly (1 process) instead of going through npx (2 processes).
   */
  private resolveCommand(command: string, args: string[]): {
    command: string;
    args: string[];
    env: Record<string, string>;
  } {
    const nodeExec = this.getNodeExecPath();
    const isSystemNode = this._isSystemNode;
    // ELECTRON_RUN_AS_NODE only means something to Electron's binary.
    // Passing it to system node.exe is a no-op, but we keep the env minimal.
    const nodeEnv: Record<string, string> = isSystemNode ? {} : { ELECTRON_RUN_AS_NODE: '1' };

    if (command === 'npx') {
      // Try direct execution of cached package (skip npx middleman).
      // findCachedPackageBin returns a real filesystem path in npm's cache
      // (~/.npm/_npx on posix, %LOCALAPPDATA%\npm-cache\_npx on Windows),
      // which system node can read — no asar boundary crossing here.
      const pkgName = this.getNpxPackageName(args);
      if (pkgName) {
        const binEntry = this.findCachedPackageBin(pkgName);
        if (binEntry) {
          console.log(`[PluginEngine] Direct exec: ${pkgName} → ${binEntry}`);
          const pkgIdx = args.findIndex(a => !a.startsWith('-'));
          const extraArgs = pkgIdx >= 0 ? args.slice(pkgIdx + 1) : [];
          return { command: nodeExec, args: [binEntry, ...extraArgs], env: nodeEnv };
        }
      }

      // Package not cached — need to run npx to download.
      // When using system node, we MUST use system npx. The bundled npx lives
      // inside app.asar, which system node.exe cannot read (MODULE_NOT_FOUND).
      if (isSystemNode) {
        const systemNpx = this.getSystemNpxPath(nodeExec);
        if (systemNpx) {
          console.log(`[PluginEngine] Using system npx: ${systemNpx}`);
          return { command: systemNpx, args, env: {} };
        }
        // No system npx available — downgrade to Electron's node so bundled
        // npx (inside asar) can be read via ELECTRON_RUN_AS_NODE.
        console.warn('[PluginEngine] System node found but no system npx — falling back to Electron node + bundled npx');
        const bundledNpx = this.getBundledNpxPath();
        if (bundledNpx) {
          const shimDir = this.ensureNodeShim();
          return {
            command: process.execPath,
            args: [bundledNpx, ...args],
            env: {
              ELECTRON_RUN_AS_NODE: '1',
              PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
            },
          };
        }
      }

      // Electron node path (macOS Helper or Windows fallback) — bundled npx works
      const bundledNpx = this.getBundledNpxPath();
      if (bundledNpx) {
        const shimDir = this.ensureNodeShim();
        return {
          command: nodeExec,
          args: [bundledNpx, ...args],
          env: {
            ...nodeEnv,
            PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
          },
        };
      }
    }

    if (command === 'node') {
      return { command: nodeExec, args, env: nodeEnv };
    }

    return { command, args, env: {} };
  }

  private _systemNpxPath: string | null | undefined;
  private getSystemNpxPath(nodeExec: string): string | null {
    if (this._systemNpxPath !== undefined) return this._systemNpxPath;
    const nodeDir = path.dirname(nodeExec);
    const candidate = process.platform === 'win32'
      ? path.join(nodeDir, 'npx.cmd')
      : path.join(nodeDir, 'npx');
    this._systemNpxPath = fs.existsSync(candidate) ? candidate : null;
    return this._systemNpxPath;
  }

  private findCachedPackageBin(pkgName: string): string | null {
    return findCachedNpxBin(pkgName);
  }

  private _bundledNpxPath: string | null | undefined;
  private getBundledNpxPath(): string | null {
    if (this._bundledNpxPath !== undefined) return this._bundledNpxPath;
    const candidates = [
      // Packaged app: inside asar (ELECTRON_RUN_AS_NODE can read asar paths)
      path.join(process.resourcesPath || '', 'app.asar', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
      // Development: project node_modules
      path.join(__dirname, '..', '..', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        this._bundledNpxPath = p;
        console.log(`[PluginEngine] Bundled npx found: ${p}`);
        return p;
      }
    }
    this._bundledNpxPath = null;
    console.warn('[PluginEngine] Bundled npx not found, will use system npx');
    return null;
  }

  private _nodeShimDir: string | null = null;
  private ensureNodeShim(): string {
    if (this._nodeShimDir) return this._nodeShimDir;

    const shimDir = path.join(getLocalDataDir(), 'bin');
    fs.mkdirSync(shimDir, { recursive: true });
    const nodeExec = this.getNodeExecPath();

    if (process.platform === 'win32') {
      const shimPath = path.join(shimDir, 'node.cmd');
      const content = `@set ELECTRON_RUN_AS_NODE=1\r\n@"${nodeExec}" %*\r\n`;
      if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, 'utf8') !== content) {
        fs.writeFileSync(shimPath, content);
      }
    } else {
      const shimPath = path.join(shimDir, 'node');
      const content = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${nodeExec}" "$@"\n`;
      if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, 'utf8') !== content) {
        fs.writeFileSync(shimPath, content, { mode: 0o755 });
      }
    }

    this._nodeShimDir = shimDir;
    console.log(`[PluginEngine] Node shim ready at ${shimDir}`);
    return shimDir;
  }

  // ─── System Node.js detection ──────────────────────────────

  private _globalNodePath: string | null | undefined;
  private getGlobalNodePath(): string | null {
    if (this._globalNodePath !== undefined) return this._globalNodePath;
    try {
      const shellEnv = this.getShellEnv();
      this._globalNodePath = execSync('npm root -g', {
        timeout: 5000,
        env: { ...process.env, ...shellEnv },
      }).toString().trim();
    } catch {
      this._globalNodePath = null;
    }
    return this._globalNodePath;
  }

  /**
   * Resolve the user's login shell environment (PATH etc.).
   * macOS GUI apps only get /usr/bin:/bin:/usr/sbin:/sbin by default,
   * missing homebrew, nvm, fnm, volta, etc. This runs the user's login
   * shell once to capture the real PATH, then caches the result.
   */
  private _shellEnv: Record<string, string> | undefined;
  private getShellEnv(): Record<string, string> {
    if (this._shellEnv) return this._shellEnv;
    this._shellEnv = {};

    if (process.platform === 'win32') return this._shellEnv;

    const shell = process.env.SHELL || '/bin/zsh';
    try {
      // Use login shell (-l) to source profile/rc files; print PATH
      const result = execSync(`${shell} -lc 'echo "__PATH__=$PATH"'`, {
        timeout: 10000,
        encoding: 'utf8',
        env: { ...process.env },
      });
      const match = result.match(/__PATH__=(.+)/);
      if (match) {
        this._shellEnv.PATH = match[1];
        console.log(`[PluginEngine] Resolved shell PATH: ${match[1].split(':').length} entries`);
      }
    } catch (err: any) {
      console.warn('[PluginEngine] Failed to resolve shell PATH:', err.message);
    }
    return this._shellEnv;
  }
}
