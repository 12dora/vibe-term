// 「成员密钥未送达」：已被 `admit-node` 接纳、但当前世代 `K_meta` 没封给它的成员。
//
// 中继模式下新节点的 admit 分两步：先 `admit-node`（成员资格），再 `meta-key {op:'admit'}`
// （把当前世代的租户元数据密钥封给它）。第二条落不下去时，新节点解不开元数据块，既读不到
// 别人的状态，也封不出自己的状态块——名字与版本永远上报不了，在各处只显示一串 node id。
//
// 以前这件事只靠浏览器标签页自己记账（sessionStorage），换台机器、刷新页面、或者补发那一刻
// 页面没挂着，欠账就彻底消失了。这里改成**服务端真相**：当前生效的 `meta-key` 记录里带着
// 逐节点的封装条目，谁不在里面一望即知，任何入口拉一次 `/api/mesh/relay/status` 都看得到。

import { decodeKeyLogRecord } from '@vibeterm/shared/auth';
import type { WrapEntry } from '@vibeterm/shared/relay';
import type { NodeCertRecord } from '../auth/user-store';

export type RelayMetaKeyLaggingNode = {
  /** 32 位小写 hex。 */
  nodeId: string;
  /** 已知显示名；只有 node id 可用（正是本状态的典型表现）时为 `null`。 */
  name: string | null;
  /** 本地已知的加入时间（毫秒）；未知为 `null`。 */
  since: number | null;
  /** 接纳它的那条 `admit-node` 的 seq，便于排查。 */
  admitSeq: number;
};

export type ListMetaKeyLaggingInput = {
  certs: readonly NodeCertRecord[];
  /** 当前生效的 `meta-key` / `set-relays` 里的逐节点封装条目。 */
  entries: readonly WrapEntry[];
  /** 当前 `K_meta` 世代；0 表示还没有租户密钥，此时谈不上「落后」。 */
  metaKeyEpoch: number;
  selfNodeId: string;
  nameOf: (nodeId: string) => string | null;
  createdAtOf: (nodeId: string) => number | null;
};

/**
 * 未吊销成员里没被当前世代 `K_meta` 封到的那些。本机自己不算（它的密钥来路是
 * `set-relays` 时的 pending stash，不一定出现在条目表里）。
 */
export function listMetaKeyLagging(input: ListMetaKeyLaggingInput): RelayMetaKeyLaggingNode[] {
  if (input.metaKeyEpoch <= 0) return [];
  const addressed = new Set(input.entries.map((entry) => entry.node_id.toLowerCase()));
  const self = input.selfNodeId.toLowerCase();
  const out: RelayMetaKeyLaggingNode[] = [];
  for (const cert of input.certs) {
    const id = cert.nodeId.toLowerCase();
    if (cert.revokedLogSeq != null || id === self || addressed.has(id)) continue;
    const name = input.nameOf(cert.nodeId);
    out.push({
      nodeId: cert.nodeId,
      name: name && name !== cert.nodeId ? name : null,
      since: input.createdAtOf(cert.nodeId),
      admitSeq: cert.admitRecordSeq,
    });
  }
  return out.sort((a, b) => a.admitSeq - b.admitSeq || a.nodeId.localeCompare(b.nodeId));
}

/** 只取 node id 的那份（版本门要用：这些成员的版本无从得知，不能当成「旧节点」挡住写入）。 */
export function metaKeyLaggingIds(rows: readonly RelayMetaKeyLaggingNode[]): Set<string> {
  return new Set(rows.map((row) => row.nodeId.toLowerCase()));
}

/**
 * 从已回放的用户密钥状态直接算 id 集合（版本门用，不需要名字与时间）。
 * 取状态 / 取证书都可能抛（用户不存在、库正在迁移）：那种情况不豁免任何人。
 */
export function metaKeyLaggingIdsFor(input: {
  stateOf: () => { metaKeyEntries: readonly WrapEntry[]; metaKeyEpoch: number };
  certs: () => readonly NodeCertRecord[];
  selfNodeId: string;
}): Set<string> {
  try {
    const state = input.stateOf();
    return metaKeyLaggingIds(
      listMetaKeyLagging({
        certs: input.certs(),
        entries: state.metaKeyEntries,
        metaKeyEpoch: state.metaKeyEpoch,
        selfNodeId: input.selfNodeId,
        nameOf: () => null,
        createdAtOf: () => null,
      })
    );
  } catch {
    return new Set();
  }
}

/**
 * 版本门的豁免：**成员密钥还没送达**的节点不算「旧节点」。
 *
 * 它们解不开当前世代的元数据块，因此封不出自己的状态块，名字与版本一律上报不了——
 * 版本未知是这条 bug 的**症状**，不是证据。把它们当旧节点挡住会造成死锁：补发
 * `meta-key` 正是唯一能让它们报出版本的动作，却被自己造成的未知版本挡在门外；
 * 顺带还让这些节点永远改不了名（`rename-node` 同样吃这道门）。
 *
 * 只豁免「旧节点解不开也不会卡死整条链」的那几类记录；`readmit-node` /
 * `notification-sink` / `rotate-root-keep` 一律照旧 fail-closed。
 */
const META_LAG_EXEMPT_RECORD_TYPES: readonly string[] = ['meta-key', 'set-relays', 'rename-node'];

export function exemptMetaKeyLaggingNodes<T extends { ok: boolean }>(
  compat: T,
  bytes: Uint8Array,
  laggingIds: (() => ReadonlySet<string>) | null
): T {
  if (compat.ok || !laggingIds) return compat;
  const blocked = compat as unknown as { ok: false; nodes: { id: string }[] };
  let type: string;
  try {
    type = decodeKeyLogRecord(bytes).type;
  } catch {
    return compat;
  }
  if (!META_LAG_EXEMPT_RECORD_TYPES.includes(type)) return compat;
  const lagging = laggingIds();
  if (lagging.size === 0) return compat;
  const nodes = blocked.nodes.filter((node) => !lagging.has(node.id.toLowerCase()));
  if (nodes.length === blocked.nodes.length) return compat;
  if (nodes.length === 0) return { ok: true } as unknown as T;
  return { ...compat, nodes } as T;
}
