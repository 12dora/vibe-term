import { describe, expect, test } from 'bun:test';
import {
  buildKeyLogRecord,
  encodeAdmitNodePayload,
  encodeKeyLogRecord,
  genesisHead,
} from '@tmex/shared/auth';
import type { NodeCertRecord } from '../auth/user-store';
import { listReadmitPending } from './relay-readmit';

function cert(nodeId: string, seq: number, revoked = false): NodeCertRecord {
  return {
    nodeId,
    userId: 'user-1',
    admitRecordSeq: seq,
    certificateBytes: new Uint8Array([1]),
    certSig: new Uint8Array([2]),
    authorizationBytes: new Uint8Array([3]),
    authorizationSig: new Uint8Array([4]),
    revokedLogSeq: revoked ? 9 : null,
  };
}

function recordAt(epoch: number): Uint8Array {
  return encodeKeyLogRecord(
    buildKeyLogRecord(genesisHead(), epoch, {
      uid: 'user-1',
      type: 'admit-node',
      payload: encodeAdmitNodePayload({
        authorization_bytes: new Uint8Array(4),
        authorization_sig: new Uint8Array(64),
        certificate_bytes: new Uint8Array(4),
        cert_sig: new Uint8Array(64),
      }),
      signer: 'root',
      credential_id: null,
    })
  );
}

describe('listReadmitPending', () => {
  test('lists unrevoked certs whose admit/readmit record epoch is behind', () => {
    const stale = recordAt(1);
    const current = recordAt(4);
    const entries = listReadmitPending({
      certs: [cert('aa', 2), cert('bb', 8), cert('cc', 3, true)],
      rootEpoch: 4,
      recordBytesAt: (seq) => (seq === 2 ? stale : seq === 8 ? current : null),
      nameOf: (id) => (id === 'aa' ? 'studio' : id),
    });
    expect(entries).toEqual([
      {
        nodeId: 'aa',
        name: 'studio',
        admitSeq: 2,
        admitRootEpoch: 1,
        authorization_bytes: expect.any(String),
        certificate_bytes: expect.any(String),
        cert_sig: expect.any(String),
      },
    ]);
  });
});
