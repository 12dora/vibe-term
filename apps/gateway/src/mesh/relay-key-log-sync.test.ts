import { describe, expect, test } from 'bun:test';
import {
  buildKeyLogRecord,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeKeyLogRecord,
  encodeSetTotpPayload,
  genesisHead,
  randomBytes,
} from '@tmex/shared/auth';
import {
  RELAY_KEYLOG_SEQ_MISMATCH,
  type RelayCtlMessage,
  generateTenantKey,
  relaySeqFromWire,
  relaySeqToWire,
  sealEnvelope,
} from '@tmex/shared/relay';
import {
  RELAY_KEYLOG_ENVELOPE_KIND,
  RelayKeyLogSync,
  decodeRelayKeyLogPlaintext,
  encodeRelayKeyLogPlaintext,
  openRelayKeyLogRecord,
  relayMemberFromRecord,
  sealRelayKeyLogRecord,
} from './relay-key-log-sync';
import { waitUntil } from './test-support';
import type { KeyLogApplier } from './types';

const LOG_KEY = generateTenantKey();

function totpRecordBytes(seq: bigint): Uint8Array {
  const record = buildKeyLogRecord({ seq: seq - 1n, hash: genesisHead().hash }, 1, {
    uid: 'user-1',
    type: 'set-totp',
    payload: encodeSetTotpPayload({
      alg: 'A256GCM',
      nonce: new Uint8Array(12).fill(1),
      ciphertext: new Uint8Array(8).fill(2),
      tag: new Uint8Array(16).fill(3),
    }),
    signer: 'root',
    credential_id: null,
  });
  return encodeKeyLogRecord(record);
}

function admitRecordBytes(seq: bigint): Uint8Array {
  const record = buildKeyLogRecord({ seq: seq - 1n, hash: genesisHead().hash }, 1, {
    uid: 'user-1',
    type: 'admit-node',
    payload: encodeAdmitNodePayload({
      authorization_bytes: new Uint8Array(8).fill(4),
      authorization_sig: new Uint8Array(64).fill(5),
      certificate_bytes: new Uint8Array(8).fill(6),
      cert_sig: new Uint8Array(64).fill(7),
    }),
    signer: 'root',
    credential_id: null,
  });
  return encodeKeyLogRecord(record);
}

type Harness = {
  sync: RelayKeyLogSync;
  sent: RelayCtlMessage[];
  applied: Array<{ bytes: Uint8Array; sig: Uint8Array }>;
  setHead: (seq: bigint) => void;
};

function harness(
  localSeq: bigint,
  stored: Array<{ seq: bigint; bytes: Uint8Array }> = []
): Harness {
  const sent: RelayCtlMessage[] = [];
  const applied: Array<{ bytes: Uint8Array; sig: Uint8Array }> = [];
  let head = localSeq;
  const applier: KeyLogApplier = {
    async head() {
      return { seq: head, hash: new Uint8Array(32) };
    },
    async applyMany(_userId, records) {
      applied.push(...records);
      for (const record of records) void record;
      head += BigInt(records.length);
      return { applied: records.length };
    },
    async list(_userId, fromSeq) {
      return stored
        .filter((row) => row.seq >= fromSeq)
        .map((row) => ({ seq: row.seq, bytes: row.bytes, sig: new Uint8Array(64).fill(9) }));
    },
  };
  const sync = new RelayKeyLogSync({
    host: {
      generation: () => 1,
      isOnline: () => true,
      isAuthenticated: () => true,
      userId: () => 'user-1',
      send: (msg) => {
        sent.push(msg);
      },
      logKey: async () => LOG_KEY,
      memberFor: (record) => relayMemberFromRecord(record),
    },
    applier,
    timeoutMs: 200,
  });
  return {
    sync,
    sent,
    applied,
    setHead: (seq) => {
      head = seq;
    },
  };
}

describe('relay key log blob', () => {
  test('明文是 {bytes,sig} 的 b64url JSON，信封可往返', async () => {
    const bytes = totpRecordBytes(3n);
    const sig = randomBytes(64);
    const plain = encodeRelayKeyLogPlaintext({ bytes, sig });
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({
      bytes: encodeBase64url(bytes),
      sig: encodeBase64url(sig),
    });
    expect(decodeRelayKeyLogPlaintext(plain)).toEqual({ bytes, sig });
    const sealed = await sealRelayKeyLogRecord(LOG_KEY, { bytes, sig });
    expect(await openRelayKeyLogRecord(LOG_KEY, sealed)).toEqual({ bytes, sig });
    await expect(openRelayKeyLogRecord(generateTenantKey(), sealed)).rejects.toThrow();
  });

  test('能打开 CLI（packages/app relay-keylog）产出的块', async () => {
    const bytes = totpRecordBytes(4n);
    const sig = randomBytes(64);
    // 与 packages/app/src/lib/relay-keylog.ts encodeRelayKeyLogPlaintext 逐字节一致
    const cliPlaintext = new TextEncoder().encode(
      JSON.stringify({ bytes: encodeBase64url(bytes), sig: encodeBase64url(sig) })
    );
    const cliBlob = await sealEnvelope(LOG_KEY, RELAY_KEYLOG_ENVELOPE_KIND, cliPlaintext);
    expect(await openRelayKeyLogRecord(LOG_KEY, cliBlob)).toEqual({ bytes, sig });
    expect(encodeRelayKeyLogPlaintext({ bytes, sig })).toEqual(cliPlaintext);
  });

  test('member 证明只对 admit/revoke 记录产生', () => {
    expect(
      relayMemberFromRecord({ bytes: totpRecordBytes(2n), sig: new Uint8Array(64) })
    ).toBeUndefined();
    const member = relayMemberFromRecord({
      bytes: admitRecordBytes(2n),
      sig: new Uint8Array(64).fill(1),
    });
    expect(member?.op).toBe('admit');
  });
});

describe('RelayKeyLogSync', () => {
  test('本地落后时按页拉取、解密并应用', async () => {
    const h = harness(1n);
    h.sync.noteRemoteHead(3n);
    await waitUntil(() => h.sent.some((msg) => msg.t === 'relay.keylog.req'));
    const req = h.sent.find((msg) => msg.t === 'relay.keylog.req');
    if (req?.t !== 'relay.keylog.req') throw new Error('missing req');
    expect(relaySeqFromWire(req.from_seq)).toBe(2n);

    const bytes2 = totpRecordBytes(2n);
    const bytes3 = totpRecordBytes(3n);
    h.sync.handleRes({
      t: 'relay.keylog.res',
      records: [
        {
          seq: relaySeqToWire(2n),
          blob: await sealRelayKeyLogRecord(LOG_KEY, { bytes: bytes2, sig: new Uint8Array(64) }),
        },
        {
          seq: relaySeqToWire(3n),
          blob: await sealRelayKeyLogRecord(LOG_KEY, { bytes: bytes3, sig: new Uint8Array(64) }),
        },
      ],
    });
    await waitUntil(() => h.applied.length === 2);
    expect(h.applied.map((row) => row.bytes)).toEqual([bytes2, bytes3]);
  });

  test('本地超前时上传缺失记录并附带 admit 成员证明', async () => {
    const bytes2 = admitRecordBytes(2n);
    const bytes3 = totpRecordBytes(3n);
    const h = harness(3n, [
      { seq: 2n, bytes: bytes2 },
      { seq: 3n, bytes: bytes3 },
    ]);
    h.sync.noteRemoteHead(1n);
    await waitUntil(() => h.sent.some((msg) => msg.t === 'relay.keylog.append'));
    const first = h.sent.find((msg) => msg.t === 'relay.keylog.append');
    if (first?.t !== 'relay.keylog.append') throw new Error('missing append');
    expect(relaySeqFromWire(first.seq)).toBe(2n);
    expect(first.member?.op).toBe('admit');
    expect(await openRelayKeyLogRecord(LOG_KEY, first.blob)).toEqual({
      bytes: bytes2,
      sig: new Uint8Array(64).fill(9),
    });

    h.sync.handleAck({ t: 'relay.keylog.ack', id: first.id, ok: true, seq: relaySeqToWire(2n) });
    await waitUntil(() => h.sent.filter((msg) => msg.t === 'relay.keylog.append').length === 2);
    const second = h.sent.filter((msg) => msg.t === 'relay.keylog.append')[1];
    if (second?.t !== 'relay.keylog.append') throw new Error('missing second append');
    expect(second.member).toBeUndefined();
    h.sync.handleAck({ t: 'relay.keylog.ack', id: second.id, ok: true, seq: relaySeqToWire(3n) });
    await waitUntil(() => h.sync.remoteHead === 3n);
  });

  test('SEQ_MISMATCH 的 ack 用中继 head 纠正本地游标', async () => {
    const h = harness(3n, [{ seq: 2n, bytes: totpRecordBytes(2n) }]);
    h.sync.noteRemoteHead(1n);
    await waitUntil(() => h.sent.some((msg) => msg.t === 'relay.keylog.append'));
    const append = h.sent.find((msg) => msg.t === 'relay.keylog.append');
    if (append?.t !== 'relay.keylog.append') throw new Error('missing append');
    h.sync.handleAck({
      t: 'relay.keylog.ack',
      id: append.id,
      ok: false,
      error: RELAY_KEYLOG_SEQ_MISMATCH,
      head: relaySeqToWire(5n),
    });
    await waitUntil(() => h.sync.remoteHead === 5n);
  });

  test('relay.keylog.push 直接应用推送来的记录', async () => {
    const h = harness(1n);
    const bytes = totpRecordBytes(2n);
    h.sync.handlePush({
      t: 'relay.keylog.push',
      records: [
        {
          seq: relaySeqToWire(2n),
          blob: await sealRelayKeyLogRecord(LOG_KEY, { bytes, sig: new Uint8Array(64) }),
        },
      ],
    });
    await waitUntil(() => h.applied.length === 1);
    expect(h.applied[0]?.bytes).toEqual(bytes);
    expect(h.sync.remoteHead).toBe(2n);
  });
});
