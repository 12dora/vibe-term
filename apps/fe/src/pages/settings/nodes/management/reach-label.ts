// 节点表 REACH 列：把 nodeReachLabel 的原始 token 映射到懒加载 i18n key。
// 不进 eager 图（node-address / merge-nodes 不得引用本模块）。

import { type NodeReachInput, nodeReachLabel } from '@/node/node-address';

const COMPOSITE_KEYS: Record<string, string> = {
  'lan/dc': 'nodes.link.lanDc',
  'lan/ws-secure': 'nodes.link.lanWs',
  'wan/dc': 'nodes.link.wanDc',
  'wan/ws-secure': 'nodes.link.wanWs',
  relay: 'nodes.link.relay',
};

const REACH_KEYS: Record<string, string> = {
  lan: 'nodes.reach.lan',
  wan: 'nodes.reach.wan',
  relay: 'nodes.reach.relay',
};

const TRANSPORT_KEYS: Record<string, string> = {
  dc: 'nodes.badge.transportDc',
  'ws-secure': 'nodes.badge.transportWs',
  relay: 'nodes.badge.transportRelay',
};

/** 表内五种常用组合的单一 key；self / 离线 / 未知混合 token 返回 `null`。 */
export function nodeReachLabelKey(input: NodeReachInput): string | null {
  const token = nodeReachLabel(input);
  if (!token) return null;
  return COMPOSITE_KEYS[token] ?? null;
}

/**
 * 渲染用的 key 序列，调用方用 ` · ` 拼接。
 * 已知组合一条；混合/残缺 token 拆成 reach + transport；推不出则 `null`（画破折号）。
 */
export function nodeReachComposeKeys(input: NodeReachInput): readonly string[] | null {
  const token = nodeReachLabel(input);
  if (!token) return null;
  const known = COMPOSITE_KEYS[token];
  if (known) return [known];
  return fallbackComposeKeys(token);
}

function fallbackComposeKeys(token: string): readonly string[] | null {
  const slash = token.indexOf('/');
  if (slash < 0) {
    const key = REACH_KEYS[token] ?? TRANSPORT_KEYS[token];
    return key ? [key] : null;
  }
  const reachKey = REACH_KEYS[token.slice(0, slash)];
  const transportKey = TRANSPORT_KEYS[token.slice(slash + 1)];
  if (!reachKey || !transportKey) return null;
  return [reachKey, transportKey];
}
