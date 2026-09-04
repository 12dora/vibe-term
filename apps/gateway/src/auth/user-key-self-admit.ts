import type { RootKey, UserKeyState } from '@tmex/shared/auth';
import {
  buildKeyLogRecord,
  computeRecordHash,
  decodeCertificate,
  decodeKeyLogRecord,
  encodeAdmitNodePayload,
  encodeKeyLogRecord,
  encodeMetaKeyPayload,
  signKeyLogRecordWithRoot,
  wrapEntryToBytes,
} from '@tmex/shared/auth';
import { generateTenantKey, wrapKeyForNodes } from '@tmex/shared/relay';
import { type NodeIdentityKeys, selfSignedNodeCertificate } from './node-identity-service';
import type { ApplyKeyLogInput, UserKeyService } from './user-key-service';

type RelayNodeKey = { nodeId: string; x25519Pk: Uint8Array };

export type SelfAdmitMetaResult = {
  records: ApplyKeyLogInput[];
  metaKey: Uint8Array;
  metaEpoch: number;
  admit: ApplyKeyLogInput;
};

function admittedNodeKeys(state: UserKeyState, extra?: RelayNodeKey): RelayNodeKey[] {
  const out: RelayNodeKey[] = [];
  const seen = new Set<string>();
  for (const [nodeId, cert] of state.nodeCerts) {
    if (cert.revoked) continue;
    try {
      const decoded = decodeCertificate(cert.certificateBytes);
      out.push({ nodeId, x25519Pk: decoded.x25519_pk });
      seen.add(nodeId.toLowerCase());
    } catch {
      // 证书损坏的节点不参与封装
    }
  }
  if (extra && !seen.has(extra.nodeId.toLowerCase())) out.push(extra);
  return out;
}

function decodeAdmitSeq(bytes: Uint8Array): bigint {
  return decodeKeyLogRecord(bytes).seq;
}

export type SelfAdmitInput = {
  service: UserKeyService;
  userId: string;
  identity: NodeIdentityKeys;
  rootKey: RootKey;
  now?: number;
};

/** 在 `service.currentState` 的链头上签一条根签名 `admit-node`。 */
export async function buildSelfAdmitRecord(input: SelfAdmitInput): Promise<ApplyKeyLogInput> {
  const now = input.now ?? Date.now();
  const state = input.service.currentState(input.userId);
  const admitPayload = await selfSignedNodeCertificate(input.identity, input.rootKey, {
    uid: input.userId,
    rootEpoch: state.rootEpoch,
    now,
  });
  const admitRecord = buildKeyLogRecord(state.head, state.rootEpoch, {
    uid: input.userId,
    type: 'admit-node',
    payload: encodeAdmitNodePayload(admitPayload),
    signer: 'root',
    credential_id: null,
  });
  const admitBytes = encodeKeyLogRecord(admitRecord);
  return { bytes: admitBytes, sig: signKeyLogRecordWithRoot(input.rootKey, admitBytes) };
}

/** 在已回放的链上连续签 `admit-node` + 换代 `meta-key`，由调用方 `applyMany` 一次提交。 */
export async function buildSelfAdmitAndMetaKey(
  input: SelfAdmitInput
): Promise<SelfAdmitMetaResult> {
  const admit = await buildSelfAdmitRecord(input);
  const state = input.service.currentState(input.userId);
  const admitHash = computeRecordHash(admit.bytes, admit.sig);
  const admitSeq = decodeAdmitSeq(admit.bytes);

  const metaKey = generateTenantKey();
  const metaEpoch = state.metaKeyEpoch + 1;
  const nodes = admittedNodeKeys(state, {
    nodeId: input.identity.nodeIdHex,
    x25519Pk: input.identity.x25519PublicKey,
  });
  const wraps = await wrapKeyForNodes({ key: metaKey, nodes });
  const metaPayload = encodeMetaKeyPayload({
    epoch: metaEpoch,
    entries: wraps.map(wrapEntryToBytes),
  });
  const metaRecord = buildKeyLogRecord({ seq: admitSeq, hash: admitHash }, state.rootEpoch, {
    uid: input.userId,
    type: 'meta-key',
    payload: metaPayload,
    signer: 'root',
    credential_id: null,
  });
  const metaBytes = encodeKeyLogRecord(metaRecord);
  const metaSig = signKeyLogRecordWithRoot(input.rootKey, metaBytes);
  return {
    records: [admit, { bytes: metaBytes, sig: metaSig }],
    metaKey,
    metaEpoch,
    admit,
  };
}
