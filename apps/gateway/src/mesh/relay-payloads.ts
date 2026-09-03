import type { StoredRelayList } from '@tmex/shared/auth';
import {
  decodeCertificate,
  encodeMetaKeyPayload,
  encodeSetRelaysPayload,
  hexToBytes,
  sha256,
  wrapEntryToBytes,
} from '@tmex/shared/auth';
import { type WrapEntry, wrapKeyForNodes } from '@tmex/shared/relay';
import type { UserStore } from '../auth/user-store';

export type RelayNodeKey = { nodeId: string; x25519Pk: Uint8Array };

export type RelayTargetInput = {
  url: string;
  tenantId: string;
  token: Uint8Array;
  priority: number;
};

/** 未吊销且属于本用户的节点证书 → X25519 公钥，用于按节点封装租户密钥。 */
export function listRelayNodeKeys(
  userStore: UserStore,
  userId: string,
  exclude: readonly string[] = []
): RelayNodeKey[] {
  const skip = new Set(exclude.map((id) => id.toLowerCase()));
  const out: RelayNodeKey[] = [];
  for (const cert of userStore.listCertsByUser(userId)) {
    if (cert.revokedLogSeq != null) continue;
    if (skip.has(cert.nodeId.toLowerCase())) continue;
    try {
      const certificate = decodeCertificate(cert.certificateBytes);
      hexToBytes(cert.nodeId);
      out.push({ nodeId: cert.nodeId, x25519Pk: certificate.x25519_pk });
    } catch {
      // 证书损坏的节点不参与封装
    }
  }
  return out;
}

export async function wrapForNodes(
  key: Uint8Array,
  nodes: readonly RelayNodeKey[]
): Promise<WrapEntry[]> {
  return wrapKeyForNodes({ key, nodes });
}

export async function buildSetRelaysPayload(input: {
  relays: readonly RelayTargetInput[];
  logKey: Uint8Array;
  metaKey: Uint8Array;
  metaEpoch: number;
  nodes: readonly RelayNodeKey[];
}): Promise<Uint8Array> {
  const empty = input.relays.length === 0;
  const logEntries = empty ? [] : await wrapForNodes(input.logKey, input.nodes);
  const metaEntries = empty ? [] : await wrapForNodes(input.metaKey, input.nodes);
  return encodeSetRelaysPayload({
    mode: 'ordered',
    relays: input.relays.map((relay) => ({
      url: relay.url,
      tenant_id: hexToBytes(relay.tenantId),
      token: relay.token,
      priority: relay.priority,
    })),
    log_key: logEntries.map(wrapEntryToBytes),
    meta_key: {
      epoch: input.metaEpoch,
      entries: metaEntries.map(wrapEntryToBytes),
    },
  });
}

export async function buildMetaKeyPayload(input: {
  metaKey: Uint8Array;
  epoch: number;
  nodes: readonly RelayNodeKey[];
}): Promise<Uint8Array> {
  const entries = await wrapForNodes(input.metaKey, input.nodes);
  return encodeMetaKeyPayload({ epoch: input.epoch, entries: entries.map(wrapEntryToBytes) });
}

export function relayPayloadHash(payload: Uint8Array): Uint8Array {
  return sha256(payload);
}

/** 把已生效的中继列表转成待签 payload 的输入，并按 url 归并新目标。 */
export function mergeRelayTargets(
  current: StoredRelayList | null,
  next: RelayTargetInput | null
): RelayTargetInput[] {
  const rows: RelayTargetInput[] = (current?.relays ?? []).map((relay) => ({
    url: relay.url,
    tenantId: relay.tenantId,
    token: relay.token,
    priority: relay.priority,
  }));
  if (!next) return rows.sort((a, b) => a.priority - b.priority);
  const idx = rows.findIndex((row) => row.url === next.url);
  if (idx >= 0) {
    const existing = rows[idx];
    rows[idx] = { ...next, priority: existing ? existing.priority : next.priority };
  } else {
    rows.push(next);
  }
  return rows.sort((a, b) => a.priority - b.priority);
}

export function nextRelayPriority(current: StoredRelayList | null): number {
  const rows = current?.relays ?? [];
  if (rows.length === 0) return 0;
  return Math.min(255, Math.max(...rows.map((row) => row.priority)) + 1);
}
