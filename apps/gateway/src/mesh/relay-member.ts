import {
  decodeAdmitNodePayload,
  decodeCertificate,
  decodeKeyLogRecord,
  encodeBase64url,
  nodeIdToHex,
} from '@tmex/shared/auth';
import type { RelayMemberProof } from '@tmex/shared/relay';
import type { UserStore } from '../auth/user-store';
import type { KeyLogApplier, MeshIdentity } from './types';

const ADMIT_SCAN_LIMIT = 64;

type MemberProofCtx = {
  identity: MeshIdentity;
  userStore: UserStore;
  applier: KeyLogApplier;
  userId: string;
};

/**
 * 自承认节点首次 uplink：本地已有 root-signed `admit-node` 时带上 member sidecar，
 * 即使 `node_certs` 投影尚未写完也能把中继注册表从 pending 提到 admitted。
 */
export async function selfAdmitMemberProof(
  ctx: MemberProofCtx
): Promise<RelayMemberProof | undefined> {
  const cert = ctx.userStore.getCert(ctx.identity.nodeId);
  if (cert && cert.userId === ctx.userId && cert.revokedLogSeq == null) {
    return proofFromSeq(ctx, BigInt(cert.admitRecordSeq));
  }
  if (!ctx.userId || !ctx.applier.list) return undefined;
  try {
    const head = await ctx.applier.head(ctx.userId);
    const from =
      head.seq > BigInt(ADMIT_SCAN_LIMIT) ? head.seq - BigInt(ADMIT_SCAN_LIMIT) + 1n : 1n;
    const rows = await ctx.applier.list(ctx.userId, from, undefined, ADMIT_SCAN_LIMIT);
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (!row) continue;
      if (!recordAdmitsNode(row.bytes, ctx.identity.nodeId)) continue;
      return { bytes: encodeBase64url(row.bytes), sig: encodeBase64url(row.sig) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function proofFromSeq(
  ctx: MemberProofCtx,
  seq: bigint
): Promise<RelayMemberProof | undefined> {
  try {
    const rows = (await ctx.applier.list?.(ctx.userId, seq, undefined, 1)) ?? [];
    const row = rows.find((entry) => entry.seq === seq);
    if (!row) return undefined;
    return { bytes: encodeBase64url(row.bytes), sig: encodeBase64url(row.sig) };
  } catch {
    return undefined;
  }
}

function recordAdmitsNode(bytes: Uint8Array, nodeId: string): boolean {
  try {
    const record = decodeKeyLogRecord(bytes);
    if (record.type !== 'admit-node') return false;
    const payload = decodeAdmitNodePayload(record.payload);
    return nodeIdToHex(decodeCertificate(payload.certificate_bytes).node_id) === nodeId;
  } catch {
    return false;
  }
}
