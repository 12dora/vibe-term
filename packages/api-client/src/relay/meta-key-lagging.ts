// 「成员密钥未送达」的成员：`GET /api/mesh/relay/status` 里的 `metaKeyLagging` 一段。
//
// 单独成文件是为了给 `tenant-api.ts` 减负；语义见 relay 架构文档 §4「补发落不下去时」。

/** node id：16 字节小写 hex。 */
const NODE_ID_HEX = /^[0-9a-f]{32}$/;

/**
 * 已接纳、但当前世代 `K_meta` 没封给它的成员。
 *
 * 中继模式下新节点的准入分两步：`admit-node`（成员资格）与 `meta-key {op:'admit'}`
 * （把当前世代的元数据密钥封给它）。第二条落不下去时该节点解不开元数据块，名字与版本
 * 一律上报不了，在各处只显示一串 node id——服务端按当前 `meta-key` 记录的封装条目判定，
 * 不依赖任何浏览器本地记账。
 */
export interface RelayMetaKeyLaggingNode {
  /** 32 位小写 hex。 */
  nodeId: string;
  /** 已知显示名；只有 node id 可用时为 `null`。 */
  name: string | null;
  /** 本地已知的加入时间（毫秒）；未知为 `null`。 */
  since: number | null;
  /** 接纳它的那条 `admit-node` 的 seq。 */
  admitSeq: number;
}

/** 旧节点不下发这一段；畸形行整条丢掉，绝不把一个没有 node id 的欠账摆上界面。 */
export function normalizeMetaKeyLagging(raw: unknown): RelayMetaKeyLaggingNode[] {
  if (!Array.isArray(raw)) return [];
  const out: RelayMetaKeyLaggingNode[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Partial<RelayMetaKeyLaggingNode>;
    if (typeof entry.nodeId !== 'string' || !NODE_ID_HEX.test(entry.nodeId)) continue;
    out.push({
      nodeId: entry.nodeId,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : null,
      since: typeof entry.since === 'number' && Number.isFinite(entry.since) ? entry.since : null,
      admitSeq: typeof entry.admitSeq === 'number' ? entry.admitSeq : 0,
    });
  }
  return out;
}
