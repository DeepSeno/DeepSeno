export interface ParsedMcpPluginConfig {
  id: string;
  name: string;
  description: string;
  enabled: true;
  mcp: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    autoStart: boolean;
  };
  source: 'manual';
}

export type ParseMcpResult =
  | { ok: true; configs: ParsedMcpPluginConfig[] }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractJsonText(rawText: string): string {
  const trimmed = rawText.trim();
  const mdMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  return mdMatch ? mdMatch[1].trim() : trimmed;
}

export function parseMcpServersJson(rawText: string, existingIds: string[]): ParseMcpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(rawText));
  } catch (err) {
    return { ok: false, errors: [`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`] };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ['MCP 配置必须是 JSON 对象'] };
  }

  const root = isPlainObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
  const entries = Object.entries(root);
  if (entries.length === 0) {
    return { ok: false, errors: ['至少需要包含一个 MCP server'] };
  }

  const existing = new Set(existingIds);
  const seen = new Set<string>();
  const errors: string[] = [];
  const configs: ParsedMcpPluginConfig[] = [];

  for (const [id, server] of entries) {
    const beforeErrorCount = errors.length;

    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      errors.push(`${id}: id 只能包含字母、数字、下划线和连字符`);
    }
    if (seen.has(id)) {
      errors.push(`${id}: 配置中出现重复 id`);
    }
    if (existing.has(id)) {
      errors.push(`${id}: 已安装同名能力，请修改 id`);
    }
    seen.add(id);

    if (!isPlainObject(server)) {
      errors.push(`${id}: server 配置必须是对象`);
      continue;
    }

    const command = server.command;
    const args = server.args;
    const env = server.env;
    const autoStart = server.autoStart;

    if (typeof command !== 'string' || command.trim() === '') {
      errors.push(`${id}: command 必须是非空字符串`);
    }
    if (args !== undefined && !Array.isArray(args)) {
      errors.push(`${id}: args 必须是数组`);
    }
    if (env !== undefined && !isPlainObject(env)) {
      errors.push(`${id}: env 必须是对象`);
    }
    if (autoStart !== undefined && typeof autoStart !== 'boolean') {
      errors.push(`${id}: autoStart 必须是 boolean`);
    }

    if (errors.length === beforeErrorCount) {
      const normalizedEnv = env && isPlainObject(env)
        ? Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)]))
        : undefined;

      configs.push({
        id,
        name: id,
        description: '',
        enabled: true,
        mcp: {
          command: String(command).trim(),
          args: Array.isArray(args) ? args.map(String) : [],
          env: normalizedEnv,
          autoStart: typeof autoStart === 'boolean' ? autoStart : true,
        },
        source: 'manual',
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, configs };
}

export function pluginMcpToJson(pluginId: string, mcp?: { command?: string; args?: string[]; env?: Record<string, string>; autoStart?: boolean }): string {
  return JSON.stringify({
    mcpServers: {
      [pluginId]: {
        command: mcp?.command || 'npx',
        args: mcp?.args || [],
        env: mcp?.env || {},
        autoStart: mcp?.autoStart !== false,
      },
    },
  }, null, 2);
}
