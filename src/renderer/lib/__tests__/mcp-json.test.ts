import { describe, expect, it } from 'vitest';
import { parseMcpServersJson } from '../mcp-json';

describe('parseMcpServersJson', () => {
  it('parses standard mcpServers JSON', () => {
    const result = parseMcpServersJson(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: { API_KEY: 'secret' },
        },
      },
    }), []);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configs).toEqual([
      {
        id: 'filesystem',
        name: 'filesystem',
        description: '',
        enabled: true,
        mcp: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: { API_KEY: 'secret' },
          autoStart: true,
        },
        source: 'manual',
      },
    ]);
  });

  it('parses top-level server map shorthand', () => {
    const result = parseMcpServersJson(JSON.stringify({
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp'] },
    }), []);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configs[0].id).toBe('playwright');
    expect(result.configs[0].mcp.command).toBe('npx');
    expect(result.configs[0].mcp.args).toEqual(['-y', '@playwright/mcp']);
    expect(result.configs[0].mcp.autoStart).toBe(true);
  });

  it('respects explicit autoStart false', () => {
    const result = parseMcpServersJson(JSON.stringify({
      mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'], autoStart: false } },
    }), []);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.configs[0].mcp.autoStart).toBe(false);
  });

  it('rejects invalid json', () => {
    const result = parseMcpServersJson('{bad', []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('JSON');
  });

  it('rejects missing command', () => {
    const result = parseMcpServersJson(JSON.stringify({ mcpServers: { bad: { args: [] } } }), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('bad: command 必须是非空字符串');
  });

  it('rejects invalid args and env', () => {
    const result = parseMcpServersJson(JSON.stringify({
      mcpServers: { bad: { command: 'npx', args: '-y package', env: [] } },
    }), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('bad: args 必须是数组');
    expect(result.errors).toContain('bad: env 必须是对象');
  });

  it('rejects unsafe id', () => {
    const result = parseMcpServersJson(JSON.stringify({
      mcpServers: { 'bad id': { command: 'npx' } },
    }), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('bad id: id 只能包含字母、数字、下划线和连字符');
  });

  it('rejects duplicate installed id', () => {
    const result = parseMcpServersJson(JSON.stringify({
      mcpServers: { filesystem: { command: 'npx' } },
    }), ['filesystem']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('filesystem: 已安装同名能力，请修改 id');
  });
});
