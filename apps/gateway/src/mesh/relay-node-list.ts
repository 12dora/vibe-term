import { decodeBase64url } from '@tmex/shared/auth';
import {
  type RelayCtlMessage,
  type RelayListNode,
  type RelayStatusBlob,
  decodeRelayRtcBlob,
  decodeRelayStatusBlob,
  encodeRelayRtcBlob,
  encodeRelayStatusBlob,
  openEnvelope,
  relaySeqFromWire,
  sealEnvelope,
} from '@tmex/shared/relay';
import type { UserStore } from '../auth/user-store';
import { jsonStable } from './ctl';
import { jsonText } from './json-text';
import { stamp } from './mesh-log';
import type { RelaySecrets } from './relay-secrets';
import type { UplinkStatus } from './types';
import type { UplinkCtlMessage, UplinkEnrollRedeemed, UplinkNodeList } from './uplink-protocol';

export type RelayListContext = {
  selfNodeId: string;
  userId: string;
  userStore: UserStore;
  secrets: RelaySecrets;
  now: number;
};

type ListEntry = UplinkNodeList['nodes'][number];

async function openStatusBlob(
  node: RelayListNode,
  secrets: RelaySecrets
): Promise<{
  name: string;
  version: string;
  tmux: boolean;
  inventory: unknown;
  endpoints: unknown;
} | null> {
  if (!node.blob) return null;
  const epoch = node.epoch ?? node.blob.epoch;
  if (epoch === undefined) return null;
  const key = await secrets.metaKey(epoch);
  if (!key) return null;
  try {
    return decodeRelayStatusBlob(await openEnvelope(key, 'status', node.blob));
  } catch {
    // 旧世代或不属于本租户的块：跳过，不影响其它节点
    return null;
  }
}

function entryFromCache(node: RelayListNode, ctx: RelayListContext): ListEntry {
  const peer = ctx.userStore.getPeer(node.id);
  return {
    id: node.id,
    name: peer?.name ?? node.id,
    online: node.online,
    endpoints: safeJson(peer?.endpointsJson, []),
    inventory: safeJson(peer?.inventoryJson, null),
    direct_capable: node.direct_capable,
    version: null,
  };
}

/**
 * `relay.list` → 与 hub `node.list` 同形状的列表，顺带把解出的状态块写进 `peer_cache`。
 * 解不开（世代未知/被排除）的节点只保留在线标志。
 */
export async function relayListToNodeList(
  msg: Extract<RelayCtlMessage, { t: 'relay.list' }>,
  ctx: RelayListContext
): Promise<UplinkNodeList> {
  const nodes: ListEntry[] = [];
  for (const node of msg.nodes) {
    if (node.id === ctx.selfNodeId) continue;
    const cert = ctx.userStore.getCert(node.id);
    if (!cert || !ctx.userId || cert.userId !== ctx.userId || cert.revokedLogSeq != null) continue;
    const blob = await openStatusBlob(node, ctx.secrets);
    if (!blob) {
      nodes.push(entryFromCache(node, ctx));
      continue;
    }
    ctx.userStore.upsertPeer({
      nodeId: node.id,
      name: blob.name || node.id,
      endpointsJson: jsonText(blob.endpoints),
      inventoryJson: jsonText(blob.inventory),
      directCapable: node.direct_capable,
      lastSeenAt: ctx.now,
      listVersion: msg.version,
    });
    nodes.push({
      id: node.id,
      name: blob.name || node.id,
      online: node.online,
      endpoints: blob.endpoints,
      inventory: blob.inventory,
      direct_capable: node.direct_capable,
      version: blob.version || null,
    });
  }
  return {
    t: 'node.list',
    version: msg.version,
    key_log_head: { seq: relaySeqFromWire(msg.key_log_head_seq), hash: new Uint8Array(32) },
    rtc: { stun: msg.rtc.stun, turn: msg.rtc.turn },
    nodes,
    hubs: [],
  };
}

export async function relayRtcToSignal(
  msg: Extract<RelayCtlMessage, { t: 'relay.rtc' }>,
  secrets: RelaySecrets
): Promise<Extract<UplinkCtlMessage, { t: 'rtc.signal' }> | null> {
  const epoch = msg.enc.epoch ?? secrets.currentMetaEpoch();
  const key = await secrets.metaKey(epoch);
  if (!key) return null;
  try {
    const blob = decodeRelayRtcBlob(await openEnvelope(key, 'rtc', msg.enc));
    return {
      t: 'rtc.signal',
      rtcSession: msg.rtcSession,
      from: msg.from,
      to: msg.to,
      ...(blob.sdp ? { sdp: blob.sdp } : {}),
      ...(blob.candidate ? { candidate: blob.candidate } : {}),
    };
  } catch {
    console.warn(stamp(`[relay] rtc blob undecryptable epoch=${epoch}`));
    return null;
  }
}

export async function sealRelayRtcSignal(
  msg: Extract<UplinkCtlMessage, { t: 'rtc.signal' }>,
  secrets: RelaySecrets
): Promise<Extract<RelayCtlMessage, { t: 'relay.rtc' }> | null> {
  const meta = await secrets.currentMetaKey();
  if (!meta) return null;
  const plain = encodeRelayRtcBlob({
    ...(msg.sdp ? { sdp: msg.sdp } : {}),
    ...(msg.candidate ? { candidate: msg.candidate } : {}),
  });
  return {
    t: 'relay.rtc',
    rtcSession: msg.rtcSession,
    from: msg.from,
    to: msg.to,
    enc: await sealEnvelope(meta.key, 'rtc', plain, meta.epoch),
  };
}

function safeJson(raw: string | null | undefined, fallback: unknown): unknown {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function relayStatusBlobOf(status: UplinkStatus, name: string): RelayStatusBlob {
  return {
    name,
    version: status.version,
    tmux: status.tmux,
    inventory: status.inventory,
    endpoints: status.endpoints,
  };
}

/** 用当前世代的 K_meta 封装状态块；没有可用密钥（尚未拿到 K_meta）时返回 null。 */
export async function buildRelayStatusMessage(
  secrets: RelaySecrets,
  status: UplinkStatus,
  name: string
): Promise<{ msg: Extract<RelayCtlMessage, { t: 'relay.status' }>; json: string } | null> {
  const meta = await secrets.currentMetaKey();
  if (!meta) return null;
  const blob = relayStatusBlobOf(status, name);
  const sealed = await sealEnvelope(meta.key, 'status', encodeRelayStatusBlob(blob), meta.epoch);
  return {
    msg: {
      t: 'relay.status',
      blob: sealed,
      epoch: meta.epoch,
      direct_capable: status.direct_capable,
    },
    json: jsonStable(blob),
  };
}

export function toUplinkEnrollRedeemed(
  msg: Extract<RelayCtlMessage, { t: 'enroll.redeemed' }>
): UplinkEnrollRedeemed | null {
  try {
    return {
      t: 'enroll.redeemed',
      certificate: decodeBase64url(msg.certificate),
      cert_sig: decodeBase64url(msg.cert_sig),
      enroll_pk: decodeBase64url(msg.enroll_pk),
      nodeId: msg.node_id,
    };
  } catch {
    return null;
  }
}
