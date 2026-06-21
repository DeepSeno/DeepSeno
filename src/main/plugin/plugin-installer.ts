import { net } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import type { PluginConfig } from './types';
import { getDeepSenoHomeDir, sanitizeSkillId } from '../skill/skill-file';

export class PluginInstaller {

  async fromUrl(url: string): Promise<PluginConfig> {
    const json = await this.fetchJson(url);
    return this.parsePluginJson(json, 'url', url);
  }

  fromManual(data: {
    id: string;
    name: string;
    description: string;
    inject_prompt?: string;
    instructions?: string;
    skill_path?: string;
    mcp?: { command: string; args: string[]; env?: Record<string, string>; autoStart: boolean };
    page?: { icon?: string; menuLabel?: string; welcomeMessage?: string };
  }): PluginConfig {
    const prompt = data.inject_prompt || data.instructions;
    if (!prompt && !data.mcp) {
      throw new Error('Plugin must have at least inject_prompt or MCP config');
    }
    return {
      id: data.id,
      name: data.name,
      description: data.description,
      enabled: true,
      inject_prompt: prompt || undefined,
      skill_path: data.skill_path || undefined,
      mcp: data.mcp || undefined,
      page: data.page || undefined,
      source: 'manual',
      version: '0.0.0',
    };
  }

  /**
   * 从远程 URL 下载 Skill 包 zip，解压到 <data>/skills/<id>/，
   * 返回 PluginConfig（skill_path 指向本地解压目录）。
   *
   * 用于市场里"真实 Skill 包"类型的一键安装。
   */
  async fromRemoteSkillPackage(
    skillPathUrl: string,
    meta: { id: string; name: string; description: string; version?: string; github_url?: string },
  ): Promise<PluginConfig> {
    const skillId = sanitizeSkillId(meta.id);
    const skillsDir = path.join(getDeepSenoHomeDir(), 'skills');
    const targetDir = path.join(skillsDir, skillId);

    // 下载 zip 到临时文件
    const tmpZip = path.join(os.tmpdir(), `deepseno-skill-${skillId}-${Date.now()}.zip`);
    await this.downloadFile(skillPathUrl, tmpZip);

    // 解压到目标目录
    fs.mkdirSync(targetDir, { recursive: true });
    try {
      if (process.platform === 'win32') {
        // Windows: 用 PowerShell 的 Expand-Archive
        execSync(`powershell -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${targetDir}' -Force"`, { timeout: 30000 });
      } else {
        // macOS/Linux: 用系统 unzip
        execSync(`unzip -o '${tmpZip}' -d '${targetDir}'`, { timeout: 30000 });
      }
    } catch (err) {
      // 清理临时文件
      try { fs.unlinkSync(tmpZip); } catch {}
      throw new Error(`Failed to unzip skill package: ${err}`);
    }

    // 清理临时 zip
    try { fs.unlinkSync(tmpZip); } catch {}

    // 如果解压后第一层只有一个子目录，把内容提上来
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) {
      const subDir = path.join(targetDir, entries[0].name);
      const subEntries = fs.readdirSync(subDir);
      for (const entry of subEntries) {
        const src = path.join(subDir, entry);
        const dst = path.join(targetDir, entry);
        fs.renameSync(src, dst);
      }
      fs.rmdirSync(subDir);
    }

    // 验证 SKILL.md 存在
    const skillMdPath = path.join(targetDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      throw new Error('Skill package does not contain SKILL.md at the top level');
    }

    return {
      id: meta.id,
      name: meta.name,
      description: meta.description,
      enabled: true,
      skill_path: targetDir,
      source: 'market',
      sourceUri: skillPathUrl,
      version: meta.version || '1.0.0',
    };
  }

  private parsePluginJson(json: any, source: PluginConfig['source'], sourceUri?: string): PluginConfig {
    if (!json.id || typeof json.id !== 'string') {
      throw new Error('Plugin JSON missing required "id" field');
    }
    const prompt = json.inject_prompt || json.instructions;
    if (!prompt && !json.mcp) {
      throw new Error('Plugin JSON must have at least "inject_prompt" or "mcp"');
    }
    return {
      id: json.id,
      name: json.name || json.id,
      description: json.description || '',
      enabled: true,
      inject_prompt: prompt || undefined,
      skill_path: json.skill_path || undefined,
      mcp: json.mcp ? {
        command: json.mcp.command || 'npx',
        args: json.mcp.args || [],
        env: json.mcp.env || undefined,
        autoStart: json.mcp.autoStart !== false,
      } : undefined,
      page: json.page || undefined,
      source,
      sourceUri,
      version: json.version || '0.0.0',
    };
  }

  private async fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = net.request(url);
      let body = '';
      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} fetching ${url}`));
          return;
        }
        response.on('data', (chunk) => { body += chunk.toString(); });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        });
      });
      request.on('error', (err) => reject(err));
      request.end();
    });
  }

  private async downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = net.request(url);
      const fileStream = fs.createWriteStream(destPath);
      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
          return;
        }
        response.on('data', (chunk) => { fileStream.write(chunk); });
        response.on('end', () => {
          fileStream.end(() => resolve());
        });
      });
      request.on('error', (err) => {
        try { fs.unlinkSync(destPath); } catch {}
        reject(err);
      });
      request.end();
    });
  }
}
