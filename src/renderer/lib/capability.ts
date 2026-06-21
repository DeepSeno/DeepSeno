export type CapabilityKind = 'skill' | 'mcp' | 'builtin';

export interface PluginKindInput {
  hasInstructions: boolean;
  hasMCP: boolean;
  skill_path?: string;
}

export interface MarketKindInput {
  tags?: string[];
  sourceUri?: string;
  plugin_type?: string;
  skill_path?: string;
}

export function getPluginKind(plugin: PluginKindInput): Exclude<CapabilityKind, 'builtin'> {
  if (plugin.hasMCP) return 'mcp';
  return 'skill';
}

export function isRealSkill(plugin: PluginKindInput): boolean {
  return !!plugin.skill_path && !plugin.hasMCP;
}

export function isHybridPlugin(plugin: PluginKindInput): boolean {
  return plugin.hasInstructions && plugin.hasMCP;
}

export function getMarketItemKind(item: MarketKindInput): Exclude<CapabilityKind, 'builtin'> {
  // v2: 优先用后端返回的 plugin_type
  if (item.plugin_type === 'skill') return 'skill';
  if (item.plugin_type === 'mcp' || item.plugin_type === 'hybrid') return 'mcp';

  // v2: 有 skill_path（远程 Skill 包 URL）→ skill
  if (item.skill_path) return 'skill';

  // 向后兼容：从 tags 推断
  const tags = (item.tags || []).map((tag) => tag.toLowerCase());
  if (tags.includes('skill')) return 'skill';
  if (tags.includes('mcp')) return 'mcp';
  if (item.sourceUri && item.sourceUri.trim()) return 'mcp';
  return 'mcp';
}
