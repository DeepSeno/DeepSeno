import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { PluginConfig } from '../plugin/types';

export function getDeepSenoHomeDir(): string {
  return path.join(os.homedir(), '.deepseno');
}

export function getSkillsDir(): string {
  return path.join(getDeepSenoHomeDir(), 'skills');
}

export function ensureSkillsDir(): string {
  const dir = getSkillsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sanitizeSkillId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function getSkillDir(skillId: string): string {
  return path.join(ensureSkillsDir(), sanitizeSkillId(skillId));
}

function escapeFrontmatterValue(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
}

export function buildSkillMarkdown(config: PluginConfig, prompt: string): string {
  return [
    '---',
    `id: "${escapeFrontmatterValue(config.id)}"`,
    `name: "${escapeFrontmatterValue(config.name || config.id)}"`,
    `description: "${escapeFrontmatterValue(config.description || '')}"`,
    `version: "${escapeFrontmatterValue(config.version || '0.0.0')}"`,
    '---',
    '',
    prompt.trim(),
    '',
  ].join('\n');
}

export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content.trim();
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content.trim();
  return content.slice(end + 4).trim();
}

export function getPromptText(config: PluginConfig): string {
  return config.inject_prompt || config.instructions || '';
}

export function ensureSkillFiles(config: PluginConfig): PluginConfig {
  const prompt = getPromptText(config);
  if (!prompt || config.mcp) return config;

  // Only create/manage SKILL.md for real skill packages (skill_path already set
  // from folder/GitHub/COS installation). Text-only prompts should NOT get
  // skill_path — otherwise isRealSkill() misclassifies them as real skills.
  if (config.skill_path) {
    const skillMdPath = path.join(config.skill_path, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      fs.writeFileSync(skillMdPath, buildSkillMarkdown(config, prompt), 'utf-8');
    }
    return { ...config, inject_prompt: prompt, instructions: undefined };
  }

  // Text prompt: just save inject_prompt directly, don't create skill_path
  return { ...config, inject_prompt: prompt, instructions: undefined };
}

export function writeSkillPrompt(config: PluginConfig, prompt: string): PluginConfig {
  // Only write to SKILL.md if skill_path is already set (real skill package).
  // Text prompts store inject_prompt in settings directly, no SKILL.md needed.
  if (config.skill_path) {
    fs.mkdirSync(config.skill_path, { recursive: true });
    fs.writeFileSync(path.join(config.skill_path, 'SKILL.md'), buildSkillMarkdown(config, prompt), 'utf-8');
  }
  return { ...config, inject_prompt: prompt, instructions: undefined };
}

export function readSkillPrompt(config: PluginConfig): string {
  if (config.skill_path) {
    try {
      const skillMdPath = path.join(config.skill_path, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        return stripFrontmatter(fs.readFileSync(skillMdPath, 'utf-8'));
      }
    } catch (err) {
      console.warn(`[Skill] Failed to read SKILL.md for ${config.id}:`, err);
    }
  }
  return getPromptText(config);
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function parseSkillMeta(markdown: string, fallbackId: string): { id: string; name: string; description: string; version: string } {
  const meta: Record<string, string> = {};
  if (markdown.startsWith('---')) {
    const end = markdown.indexOf('\n---', 3);
    if (end !== -1) {
      for (const line of markdown.slice(3, end).split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (key) meta[key] = value;
      }
    }
  }
  return {
    id: sanitizeSkillId(meta.id || fallbackId),
    name: meta.name || meta.id || fallbackId,
    description: meta.description || '',
    version: meta.version || '0.0.0',
  };
}

export function installSkillFromDirectory(sourceDir: string): PluginConfig {
  const stat = fs.statSync(sourceDir);
  if (!stat.isDirectory()) throw new Error('请选择 Skill 文件夹');
  const skillMdPath = path.join(sourceDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) throw new Error('Skill 文件夹第一层必须包含 SKILL.md');

  const markdown = fs.readFileSync(skillMdPath, 'utf-8');
  const fallbackId = sanitizeSkillId(path.basename(sourceDir));
  const meta = parseSkillMeta(markdown, fallbackId);
  const targetDir = getSkillDir(meta.id);
  if (path.resolve(sourceDir) !== path.resolve(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    copyDir(sourceDir, targetDir);
  }
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    enabled: true,
    inject_prompt: stripFrontmatter(markdown),
    skill_path: targetDir,
    source: 'manual',
    version: meta.version,
  };
}

export function parseGithubSkillUrl(input: string): { owner: string; repo: string; subPath: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('请输入有效的 GitHub 仓库链接');
  }
  if (url.hostname !== 'github.com') throw new Error('仅支持 github.com 链接');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('GitHub 链接必须包含 owner/repo');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, '');
  let subPath = '';
  const treeIdx = parts.indexOf('tree');
  if (treeIdx !== -1 && parts.length > treeIdx + 2) {
    subPath = parts.slice(treeIdx + 2).join('/');
  }
  return { owner, repo, subPath };
}

export async function verifyGithubSkillUrl(input: string): Promise<{ ok: true; skillUrl: string } | { ok: false; error: string }> {
  try {
    const { owner, repo, subPath } = parseGithubSkillUrl(input);
    const encodedPath = ['contents', subPath, 'SKILL.md'].filter(Boolean).join('/');
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/${encodedPath}`;
    const res = await fetch(apiUrl, { headers: { Accept: 'application/vnd.github.raw' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: '指定 GitHub 路径第一层未找到 SKILL.md' };
    return { ok: true, skillUrl: input };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function installSkillFromGithub(input: string): PluginConfig {
  const { owner, repo, subPath } = parseGithubSkillUrl(input);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseno-skill-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', `https://github.com/${owner}/${repo}.git`, tmpDir], { timeout: 120000 });
    const skillDir = subPath ? path.join(tmpDir, subPath) : tmpDir;
    return { ...installSkillFromDirectory(skillDir), source: 'url', sourceUri: input };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
