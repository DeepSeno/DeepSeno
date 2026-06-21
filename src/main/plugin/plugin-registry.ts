import { net } from 'electron';
import type { PluginMeta } from './types';

declare const __API_BASE_URL__: string;
const API_BASE_URL = typeof __API_BASE_URL__ !== 'undefined' ? __API_BASE_URL__ : '';
const REMOTE_REGISTRY_URL = `${API_BASE_URL}/plugins/registry`;

const BUILTIN_LIST: PluginMeta[] = [
  { id: 'filesystem', name: '文件系统', description: '读写本地文件', version: '1.0.0', source: 'npm', sourceUri: '@modelcontextprotocol/server-filesystem', tags: ['mcp', 'file'], icon: 'folder' },
  { id: 'memory', name: '持久记忆', description: 'MCP 知识图谱记忆', version: '1.0.0', source: 'npm', sourceUri: '@modelcontextprotocol/server-memory', tags: ['mcp', 'memory'], icon: 'brain' },
  { id: 'sequential-thinking', name: '顺序思维', description: '链式推理思考', version: '1.0.0', source: 'npm', sourceUri: '@modelcontextprotocol/server-sequential-thinking', tags: ['mcp', 'reasoning'], icon: 'cpu' },
  { id: 'fetch', name: '网页抓取', description: '抓取网页内容', version: '1.0.0', source: 'npm', sourceUri: '@kazuph/mcp-fetch', tags: ['mcp', 'web'], icon: 'globe' },
  { id: 'playwright', name: '浏览器自动化', description: 'Playwright 浏览器控制', version: '1.0.0', source: 'npm', sourceUri: '@playwright/mcp', tags: ['mcp', 'browser'], icon: 'monitor' },
  { id: 'meeting_expert', name: '会议专家', description: '会议纪要与行动项提取', version: '1.0.0', source: 'npm', sourceUri: '', tags: ['skill', 'meeting'], icon: 'clipboard' },
  { id: 'email_writer', name: '邮件助手', description: '专业邮件撰写', version: '1.0.0', source: 'npm', sourceUri: '', tags: ['skill', 'email'], icon: 'mail' },
  { id: 'weekly_reporter', name: '周报生成', description: '自动汇总周报', version: '1.0.0', source: 'npm', sourceUri: '', tags: ['skill', 'report'], icon: 'bar-chart' },
  { id: 'task_planner', name: '任务规划', description: '需求拆解与排期', version: '1.0.0', source: 'npm', sourceUri: '', tags: ['skill', 'planning'], icon: 'lightbulb' },
  { id: 'pptx_designer', name: 'PPT 设计师', description: '演示文稿设计', version: '1.0.0', source: 'npm', sourceUri: '', tags: ['skill', 'document'], icon: 'presentation' },
];

export class PluginRegistry {
  private remoteList: PluginMeta[] | null = null;

  async fetchRemote(): Promise<void> {
    try {
      const json = await this.fetchJson(REMOTE_REGISTRY_URL);
      if (Array.isArray(json)) {
        this.remoteList = json
          .map((item: any) => this.normalizeRemoteItem(item))
          .filter((p: PluginMeta | null): p is PluginMeta => p !== null);
        console.log(`[PluginRegistry] Fetched ${this.remoteList.length} plugins from remote`);
      }
    } catch (err) {
      console.warn('[PluginRegistry] Failed to fetch remote registry:', err);
    }
  }

  /**
   * Map server-side PluginMeta fields to desktop PluginMeta.
   * Server (v2) returns: { slug, name, description, version, icon, tags, source_url,
   *   source_uri, config_json, inject_prompt, skill_path, github_url, plugin_type, source }
   * Desktop expects: { id, name, description, version, source, sourceUri, tags, icon,
   *   config_json, inject_prompt, skill_path, github_url, plugin_type }
   *
   * 向后兼容：旧后端不返回 inject_prompt/skill_path/github_url/plugin_type，
   * 从 config_json 推断。
   */
  private normalizeRemoteItem(item: any): PluginMeta | null {
    const id = item.slug || item.id;
    if (!id) return null;

    const sourceUri = item.source_uri || item.sourceUri || '';
    let tags: string[] = Array.isArray(item.tags) ? item.tags.map(String) : [];
    const configJson: string | undefined = item.config_json || undefined;

    // v2 字段直接取
    const injectPrompt: string | undefined = item.inject_prompt || undefined;
    const skillPath: string | undefined = item.skill_path || undefined;
    const githubUrl: string | undefined = item.github_url || undefined;
    const pluginType: string | undefined = item.plugin_type || undefined;
    const source: string = item.source || 'market';

    // 向后兼容：旧后端 tags 为空时从 config_json / plugin_type 推断
    if (tags.length === 0) {
      if (pluginType === 'mcp') tags.push('mcp');
      else if (pluginType === 'skill') tags.push('skill');
      else if (pluginType === 'hybrid') tags.push('mcp', 'skill');
      else if (configJson) {
        try {
          const cfg = JSON.parse(configJson);
          const hasMcp = !!cfg.mcp;
          const hasInstructions = !!(cfg.inject_prompt || cfg.instructions);
          if (hasMcp) tags.push('mcp');
          if (hasInstructions && !hasMcp) tags.push('skill');
          if (hasInstructions && hasMcp) tags.push('mcp', 'skill');
        } catch { /* malformed config_json — leave tags empty */ }
      }
    }

    return {
      id,
      name: item.name || id,
      description: item.description || '',
      version: item.version || '1.0.0',
      source: (source === 'market' ? 'npm' : 'npm') as 'npm' | 'url',
      sourceUri,
      tags: tags.length > 0 ? tags : undefined,
      icon: item.icon || undefined,
      config_json: configJson,
      inject_prompt: injectPrompt,
      skill_path: skillPath,
      github_url: githubUrl,
      plugin_type: pluginType,
    };
  }

  getList(): PluginMeta[] {
    return this.remoteList || BUILTIN_LIST;
  }

  get(id: string): PluginMeta | undefined {
    return this.getList().find(p => p.id === id);
  }

  private fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = net.request(url);
      let body = '';
      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        response.on('data', (chunk) => { body += chunk.toString(); });
        response.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
        });
      });
      request.on('error', reject);
      request.end();
    });
  }
}
