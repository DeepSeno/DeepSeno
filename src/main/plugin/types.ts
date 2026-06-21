import type { Client } from '@modelcontextprotocol/sdk/client/index';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';

// ─── Plugin Configuration (persisted in settings) ─────────────

export interface PluginPageConfig {
  icon?: string;
  menuLabel?: string;
  welcomeMessage?: string;
}

export interface PluginMCPConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  autoStart: boolean;
}

export interface PluginConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Prompt text injected into Agent system prompt. Replaces legacy `instructions`. */
  inject_prompt?: string;
  /** Real Skill folder path, expected to contain SKILL.md. */
  skill_path?: string;
  /** Legacy prompt field kept only for reading old settings/plugin JSON. */
  instructions?: string;
  mcp?: PluginMCPConfig;
  page?: PluginPageConfig;
  source: 'builtin' | 'market' | 'npm' | 'url' | 'manual';
  sourceUri?: string;
  version?: string;
}

// ─── Runtime State ────────────────────────────────────────────

export interface MCPConnection {
  client: Client;
  transport: StdioClientTransport;
  serverInfo?: { name: string; version: string };
  retryCount: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  manualStop: boolean;
}

export interface LogEntry {
  timestamp: number;
  level: 'info' | 'error' | 'tool' | 'event';
  message: string;
}

export interface PluginToolInfo {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface PluginInstance {
  config: PluginConfig;
  status: 'active' | 'stopped' | 'error';
  mcpConnection?: MCPConnection;
  tools: PluginToolInfo[];
  logs: LogEntry[];
  error?: string;
}

// ─── Market Listing ───────────────────────────────────────────

export interface PluginMeta {
  id: string;
  name: string;
  description: string;
  version: string;
  source: 'npm' | 'url';
  sourceUri: string;
  tags?: string[];
  icon?: string;
  /** Full plugin JSON config from server registry; parsed during install */
  config_json?: string;
  /** v2: 提示词文本（直接从后端读取，避免解析 config_json） */
  inject_prompt?: string;
  /** v2: 真实 Skill 包的 COS 下载 URL（客户端下载解压安装） */
  skill_path?: string;
  /** v2: GitHub 仓库地址 */
  github_url?: string;
  /** v2: 插件类型 'mcp' | 'skill' | 'hybrid' */
  plugin_type?: string;
}

// ─── Plugin Status (for IPC serialization) ────────────────────

export interface PluginStatusInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  hasInstructions: boolean;
  hasMCP: boolean;
  skill_path?: string;
  status: 'active' | 'stopped' | 'error';
  toolCount: number;
  error?: string;
  source: PluginConfig['source'];
  sourceUri?: string;
  version?: string;
  page?: PluginPageConfig;
  serverInfo?: { name: string; version: string };
}
