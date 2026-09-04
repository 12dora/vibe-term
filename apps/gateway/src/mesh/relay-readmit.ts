import { decodeKeyLogRecord, encodeBase64url } from '@tmex/shared/auth';
import type { NodeCertRecord, UserStore } from '../auth/user-store';

export type ReadmitPrepareEntry = {
  nodeId: string;
  name: string;
  admitSeq: number;
  admitRootEpoch: number;
  authorization_bytes: string;
  certificate_bytes: string;
  cert_sig: string;
};

export type ReadmitPrepare = {
  rootEpoch: number;
  entries: ReadmitPrepareEntry[];
};

export function nodeDisplayName(userStore: UserStore, nodeId: string): string {
  return userStore.getNode(nodeId)?.name ?? userStore.getPeer(nodeId)?.name ?? nodeId;
}

export function admitRecordRootEpoch(recordBytes: Uint8Array | null | undefined): number | null {
  if (!recordBytes) return null;
  try {
    return decodeKeyLogRecord(recordBytes).root_epoch;
  } catch {
    return null;
  }
}

export function listReadmitPending(input: {
  certs: readonly NodeCertRecord[];
  rootEpoch: number;
  recordBytesAt: (seq: number) => Uint8Array | null;
  nameOf: (nodeId: string) => string;
}): ReadmitPrepareEntry[] {
  const entries: ReadmitPrepareEntry[] = [];
  for (const cert of input.certs) {
    if (cert.revokedLogSeq != null) continue;
    const epoch = admitRecordRootEpoch(input.recordBytesAt(cert.admitRecordSeq)) ?? -1;
    if (epoch >= input.rootEpoch) continue;
    entries.push({
      nodeId: cert.nodeId,
      name: input.nameOf(cert.nodeId),
      admitSeq: cert.admitRecordSeq,
      admitRootEpoch: Math.max(0, epoch),
      authorization_bytes: encodeBase64url(cert.authorizationBytes),
      certificate_bytes: encodeBase64url(cert.certificateBytes),
      cert_sig: encodeBase64url(cert.certSig),
    });
  }
  return entries;
}

export function buildReadmitPrepare(input: {
  userStore: UserStore;
  userId: string;
  rootEpoch: number;
  recordBytesAt: (seq: number) => Uint8Array | null;
}): ReadmitPrepare {
  return {
    rootEpoch: input.rootEpoch,
    entries: listReadmitPending({
      certs: input.userStore.listCertsByUser(input.userId),
      rootEpoch: input.rootEpoch,
      recordBytesAt: input.recordBytesAt,
      nameOf: (nodeId) => nodeDisplayName(input.userStore, nodeId),
    }),
  };
}
