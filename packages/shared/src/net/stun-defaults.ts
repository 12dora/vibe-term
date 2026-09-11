// 随发行版分发的内置 STUN 列表与 env 覆盖语义。安装器不再把默认值写进 app.env，
// 节点/hub/中继在 env 未设置时直接取这里的列表，升级即生效；历史默认串用于升级时识别
// 「装机时冻结的旧默认」并从 app.env 中移除。

export const BUILTIN_STUN_SERVERS: readonly string[] = [
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

export const LEGACY_DEFAULT_STUN_LISTS: readonly string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478',
  // 每次修改 BUILTIN_STUN_SERVERS 都要把旧字面量追加到这里
  'stun:stun.miwifi.com:3478,stun:stun.chat.bilibili.com:3478,stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478',
];

export type StunEnvSource = 'builtin' | 'custom' | 'disabled';

export type StunEnvConfig = { servers: string[]; source: StunEnvSource };

export type StunEffectiveSource = 'node-custom' | 'node-disabled' | 'hub-custom' | 'builtin';

const DISABLE_WORDS = new Set(['none', 'off']);

export function splitStunList(raw: string): string[] {
  const out: string[] = [];
  for (const item of raw.split(',')) {
    const value = item.trim();
    if (value.length > 0 && !out.includes(value)) out.push(value);
  }
  return out;
}

export function parseStunServersEnv(raw: string | undefined): StunEnvConfig {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return { servers: [...BUILTIN_STUN_SERVERS], source: 'builtin' };
  if (DISABLE_WORDS.has(trimmed.toLowerCase())) return { servers: [], source: 'disabled' };
  return { servers: splitStunList(trimmed), source: 'custom' };
}

export function isLegacyDefaultStunList(raw: string): boolean {
  const normalized = splitStunList(raw).join(',');
  return LEGACY_DEFAULT_STUN_LISTS.some((legacy) => splitStunList(legacy).join(',') === normalized);
}

/** 优先级：节点自定义 > 节点禁用 > hub/中继下发的自定义列表 > 内置列表。 */
export function resolveEffectiveStun(input: {
  local: StunEnvConfig;
  distributed: readonly string[] | null | undefined;
}): { stun: string[]; source: StunEffectiveSource } {
  if (input.local.source === 'custom')
    return { stun: [...input.local.servers], source: 'node-custom' };
  if (input.local.source === 'disabled') return { stun: [], source: 'node-disabled' };
  const distributed = input.distributed ?? [];
  if (distributed.length > 0) return { stun: [...distributed], source: 'hub-custom' };
  return { stun: [...BUILTIN_STUN_SERVERS], source: 'builtin' };
}
