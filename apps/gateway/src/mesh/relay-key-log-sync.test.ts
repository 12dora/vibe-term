import { describe, expect, spyOn, test } from 'bun:test';
import {
  buildKeyLogRecord,
  computeRecordHash,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeKeyLogRecord,
  encodeRotateRootKeepPayload,
  encodeSetTotpPayload,
  genesisHead,
  randomBytes,
} from '@vibeterm/shared/auth';
import {
  RELAY_KEYLOG_ENVELOPE_KIND,
  RELAY_KEYLOG_SEQ_MISMATCH,
  type RelayCtlMessage,
  decodeRelayKeyLogPlaintext,
  encodeRelayKeyLogPlaintext,
  generateTenantKey,
  openRelayKeyLogRecord,
  relaySeqFromWire,
  relaySeqToWire,
  sealEnvelope,
  sealRelayKeyLogRecord,
} from '@vibeterm/shared/relay';
import {
  type RelayKeyLogPushMode,
  RelayKeyLogSync,
  relayMemberFromRecord,
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

function rotateRecordBytes(seq: bigint): Uint8Array {
  const record = buildKeyLogRecord({ seq: seq - 1n, hash: genesisHead().hash }, 1, {
    uid: 'user-1',
    type: 'rotate-root-keep',
    payload: encodeRotateRootKeepPayload({
      root_public_key: new Uint8Array(32).fill(8),
      kdf_params: { salt: new Uint8Array(16), memory_kib: 8, iterations: 1, parallelism: 1 },
      totp: null,
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
  synced: () => number;
  setHead: (seq: bigint) => void;
};

const LOCAL_SIG = new Uint8Array(64).fill(9);

function harness(
  localSeq: bigint,
  stored: Array<{ seq: bigint; bytes: Uint8Array }> = [],
  opts?: { pushMode?: RelayKeyLogPushMode; url?: string }
): Harness {
  const sent: RelayCtlMessage[] = [];
  const applied: Array<{ bytes: Uint8Array; sig: Uint8Array }> = [];
  let head = localSeq;
  let syncedCount = 0;
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
    async list(_userId, fromSeq, _signal, limit) {
      const rows = stored
        .filter((row) => row.seq >= fromSeq)
        .map((row) => ({ seq: row.seq, bytes: row.bytes, sig: LOCAL_SIG }));
      return limit === undefined ? rows : rows.slice(0, limit);
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
      onSynced: () => {
        syncedCount += 1;
      },
      url: () => opts?.url ?? 'https://relay-b.example',
    },
    applier,
    timeoutMs: 200,
    ...(opts?.pushMode ? { pushMode: opts.pushMode } : {}),
  });
  return {
    sync,
    sent,
    applied,
    synced: () => syncedCount,
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
    const readmit = buildKeyLogRecord({ seq: 2n, hash: genesisHead().hash }, 1, {
      uid: 'user-1',
      type: 'readmit-node',
      payload: encodeAdmitNodePayload({
        authorization_bytes: new Uint8Array(8).fill(4),
        authorization_sig: new Uint8Array(64).fill(5),
        certificate_bytes: new Uint8Array(8).fill(6),
        cert_sig: new Uint8Array(64).fill(7),
      }),
      signer: 'root',
      credential_id: null,
    });
    expect(
      relayMemberFromRecord({
        bytes: encodeKeyLogRecord(readmit),
        sig: new Uint8Array(64).fill(1),
      })?.op
    ).toBe('admit');
  });
});

describe('RelayKeyLogSync', () => {
  test('head query decrypts the announced relay sequence and hashes bytes plus signature', async () => {
    const h = harness(3n);
    h.sync.noteRemoteHead(3n);
    const pending = h.sync.queryHead();
    await waitUntil(() => h.sent.some((msg) => msg.t === 'relay.keylog.req'));
    const record = { bytes: totpRecordBytes(3n), sig: randomBytes(64) };
    h.sync.handleRes({
      t: 'relay.keylog.res',
      records: [{ seq: 3, blob: await sealRelayKeyLogRecord(LOG_KEY, record) }],
    });
    expect(await pending).toEqual({ seq: 3n, hash: computeRecordHash(record.bytes, record.sig) });
  });

  for (const invalid of ['wrong-key', 'wrong-sequence', 'missing'] as const) {
    test(`head query refuses ${invalid} relay record`, async () => {
      const h = harness(3n);
      h.sync.noteRemoteHead(3n);
      const pending = h.sync.queryHead();
      await waitUntil(() => h.sent.some((msg) => msg.t === 'relay.keylog.req'));
      const blob = await sealRelayKeyLogRecord(
        invalid === 'wrong-key' ? generateTenantKey() : LOG_KEY,
        { bytes: totpRecordBytes(invalid === 'wrong-sequence' ? 2n : 3n), sig: randomBytes(64) }
      );
      h.sync.handleRes({
        t: 'relay.keylog.res',
        records: invalid === 'missing' ? [] : [{ seq: 3, blob }],
      });
      expect(await pending).toBeNull();
    });
  }

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

describe('RelayKeyLogSync 健壮性', () => {
  test('rotate-root 记录也带明文 sidecar，中继才跟得上根公钥', () => {
    const member = relayMemberFromRecord({
      bytes: rotateRecordBytes(2n),
      sig: new Uint8Array(64).fill(1),
    });
    expect(member?.op).toBe('rotate-root');
  });

  test('解不开的记录被跳过而不是永远堵住同步', async () => {
    const h = harness(1n);
    h.sync.noteRemoteHead(3n);
    await waitUntil(() => h.sent.some((msg) => msg.t === 'relay.keylog.req'));
    h.sync.handleRes({
      t: 'relay.keylog.res',
      records: [
        {
          seq: relaySeqToWire(2n),
          // 别的租户密钥封的块：本节点永远解不开
          blob: await sealRelayKeyLogRecord(generateTenantKey(), {
            bytes: totpRecordBytes(2n),
            sig: new Uint8Array(64),
          }),
        },
      ],
    });
    await waitUntil(() => h.sync.skipped > 0, 2_000);
    expect(h.sync.blockedSeq).toBe(2n);
    expect(h.applied).toHaveLength(0);
    // 没追平就不能报「同步完成」
    expect(h.sync.caughtUp).toBe(false);
    expect(h.synced()).toBe(0);
    // 重连清掉卡点，允许再试一次
    h.sync.reset();
    expect(h.sync.blockedSeq).toBeNull();
  });

  test('上传缺失记录分页进行，超过一页也能全部推上去', async () => {
    const total = 80;
    const stored = Array.from({ length: total }, (_, i) => ({
      seq: BigInt(i + 2),
      bytes: totpRecordBytes(BigInt(i + 2)),
    }));
    const h = harness(BigInt(total + 1), stored);
    h.sync.noteRemoteHead(1n);
    const appends = (): Extract<RelayCtlMessage, { t: 'relay.keylog.append' }>[] =>
      h.sent.filter((msg) => msg.t === 'relay.keylog.append') as Extract<
        RelayCtlMessage,
        { t: 'relay.keylog.append' }
      >[];
    for (let i = 0; i < total; i++) {
      await waitUntil(() => appends().length === i + 1, 2_000);
      const msg = appends()[i];
      if (!msg) throw new Error('missing append');
      h.sync.handleAck({
        t: 'relay.keylog.ack',
        id: msg.id,
        ok: true,
        seq: relaySeqToWire(BigInt(i + 2)),
      });
    }
    await waitUntil(() => h.sync.remoteHead === BigInt(total + 1), 2_000);
    await waitUntil(() => h.synced() > 0, 2_000);
    expect(h.sync.caughtUp).toBe(true);
  });
});

describe('RelayKeyLogSync prefix-verified secondary', () => {
  const prefixOpts = { pushMode: 'prefix-verified' as const, url: 'https://relay-b.example' };

  async function sealAt(seq: bigint, bytes: Uint8Array, sig = LOCAL_SIG) {
    return sealRelayKeyLogRecord(LOG_KEY, { bytes, sig });
  }

  test('远端是本地前缀时才 pushMissing', async () => {
    const bytes1 = totpRecordBytes(1n);
    const bytes2 = totpRecordBytes(2n);
    const bytes3 = totpRecordBytes(3n);
    const h = harness(
      3n,
      [
        { seq: 1n, bytes: bytes1 },
        { seq: 2n, bytes: bytes2 },
        { seq: 3n, bytes: bytes3 },
      ],
      prefixOpts
    );
    h.sync.noteRemoteHead(1n);
    await waitUntil(() => h.sent.some((msg) => msg.t === 'relay.keylog.req'));
    expect(h.sent.some((msg) => msg.t === 'relay.keylog.append')).toBe(false);
    h.sync.handleRes({
      t: 'relay.keylog.res',
      records: [{ seq: 1, blob: await sealAt(1n, bytes1) }],
    });
    await waitUntil(() => h.sent.some((msg) => msg.t === 'relay.keylog.append'));
    const first = h.sent.find((msg) => msg.t === 'relay.keylog.append');
    if (first?.t !== 'relay.keylog.append') throw new Error('missing append');
    expect(relaySeqFromWire(first.seq)).toBe(2n);
    expect(h.sync.diverged).toBe(false);
  });

  test('空远端日志视为前缀，引导新中继', async () => {
    const bytes1 = totpRecordBytes(1n);
    const bytes2 = totpRecordBytes(2n);
    const h = harness(
      2n,
      [
        { seq: 1n, bytes: bytes1 },
        { seq: 2n, bytes: bytes2 },
      ],
      prefixOpts
    );
    h.sync.noteRemoteHead(0n);
    await waitUntil(() => h.sent.some((msg) => msg.t === 'relay.keylog.append'));
    expect(h.sent.some((msg) => msg.t === 'relay.keylog.req')).toBe(false);
    const first = h.sent.find((msg) => msg.t === 'relay.keylog.append');
    if (first?.t !== 'relay.keylog.append') throw new Error('missing append');
    expect(relaySeqFromWire(first.seq)).toBe(1n);
    expect(h.sync.diverged).toBe(false);
  });

  test('分叉时不 push，只记一次日志并标 diverged', async () => {
    const bytes1 = totpRecordBytes(1n);
    const bytes2 = totpRecordBytes(2n);
    const h = harness(
      2n,
      [
        { seq: 1n, bytes: bytes1 },
        { seq: 2n, bytes: bytes2 },
      ],
      prefixOpts
    );
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.sync.noteRemoteHead(1n);
      await waitUntil(() => h.sent.some((msg) => msg.t === 'relay.keylog.req'));
      h.sync.handleRes({
        t: 'relay.keylog.res',
        records: [
          {
            seq: 1,
            blob: await sealAt(1n, totpRecordBytes(1n), new Uint8Array(64).fill(3)),
          },
        ],
      });
      await waitUntil(() => h.sync.diverged);
      expect(h.sent.some((msg) => msg.t === 'relay.keylog.append')).toBe(false);
      expect(h.sync.caughtUp).toBe(false);
      const lines = warn.mock.calls.map((args) => String(args[0]));
      expect(
        lines.some((line) =>
          line.includes(
            '[mesh][relay] key-log diverged url=https://relay-b.example remote_head=1 local_head=2'
          )
        )
      ).toBe(true);
      const before = lines.filter((line) => line.includes('key-log diverged')).length;
      h.sync.noteRemoteHead(1n);
      await waitUntil(() => h.sent.filter((msg) => msg.t === 'relay.keylog.req').length >= 2);
      h.sync.handleRes({
        t: 'relay.keylog.res',
        records: [
          {
            seq: 1,
            blob: await sealAt(1n, totpRecordBytes(1n), new Uint8Array(64).fill(3)),
          },
        ],
      });
      await waitUntil(() => h.sync.diverged);
      const after = warn.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes('key-log diverged')).length;
      expect(after).toBe(before);
    } finally {
      warn.mockRestore();
    }
  });
});
