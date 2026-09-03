import { describe, expect, it } from 'bun:test';
import { x25519 } from '@noble/curves/ed25519.js';
import { generateTenantKey, unwrapKeyForNode, wrapKeyForNode } from '../relay/tenant-cipher';
import type { WrapEntry } from '../relay/tenant-cipher';
import { bytesToHex, encodeBase64url, encodeKeyLogRecord, hexToBytes } from './encoding';
import type { KeyLogType } from './encoding';
import {
  KEYLOG_RECORD_COMPAT,
  KEY_LOG_SIGNER_MATRIX,
  RELAY_RECORD_TYPES,
  applyKeyLogRecord,
  buildKeyLogRecord,
  computeRecordHash,
  emptyUserKeyState,
  signKeyLogRecordWithRoot,
  verifyKeyLogRecord,
} from './key-log';
import type { UserKeyState } from './key-log';
import {
  MIN_RELAY_RECORD_VERSION,
  type MetaKeyPayload,
  RELAY_RECORD_MAX_RELAYS,
  type SetRelaysPayload,
  decodeMetaKeyPayload,
  decodeSetRelaysPayload,
  encodeMetaKeyPayload,
  encodeSetRelaysPayload,
  wrapEntryFromBytes,
  wrapEntryToBytes,
} from './relay-records';
import { rootKeyFromSeed } from './root-key';

const UID = 'user-1';
const NODE_ID = 'a1'.repeat(16);
const TENANT_ID = hexToBytes('bc'.repeat(16));

function root(byte: number) {
  return rootKeyFromSeed(new Uint8Array(32).fill(byte));
}

function wrapBytes(nodeId = NODE_ID) {
  return {
    node_id: hexToBytes(nodeId),
    eph_pk: new Uint8Array(32).fill(2),
    nonce: new Uint8Array(12).fill(3),
    ct: new Uint8Array(48).fill(4),
  };
}

function setRelaysPayload(overrides: Partial<SetRelaysPayload> = {}): SetRelaysPayload {
  return {
    mode: 'ordered',
    relays: [
      {
        url: 'https://relay-a.example.com',
        tenant_id: TENANT_ID,
        token: new Uint8Array(32).fill(5),
        priority: 0,
      },
      {
        url: 'https://relay-b.example.com',
        tenant_id: TENANT_ID,
        token: new Uint8Array(32).fill(6),
        priority: 1,
      },
    ],
    log_key: [wrapBytes()],
    meta_key: { epoch: 1, entries: [wrapBytes()] },
    ...overrides,
  };
}

function state(): UserKeyState {
  return emptyUserKeyState(root(1).publicKey);
}

async function commit(
  current: UserKeyState,
  type: KeyLogType,
  payload: Uint8Array,
  signer = root(1)
) {
  const record = buildKeyLogRecord(current.head, current.rootEpoch, {
    uid: UID,
    type,
    payload,
    signer: 'root',
    credential_id: null,
  });
  const bytes = encodeKeyLogRecord(record);
  const sig = signKeyLogRecordWithRoot(signer, bytes);
  const verified = await verifyKeyLogRecord(bytes, sig, {
    head: current.head,
    rootEpoch: current.rootEpoch,
    rootPublicKey: current.rootPublicKey,
    resolvePasskey: () => null,
  });
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error(verified.error);
  return applyKeyLogRecord(current, verified.record, computeRecordHash(bytes, sig));
}

describe('relay 记录的 Borsh 编解码', () => {
  it('set-relays round-trip 保序保字段', () => {
    const payload = setRelaysPayload();
    const decoded = decodeSetRelaysPayload(encodeSetRelaysPayload(payload));
    expect(decoded.mode).toBe('ordered');
    expect(decoded.relays.map((relay) => relay.url)).toEqual([
      'https://relay-a.example.com',
      'https://relay-b.example.com',
    ]);
    expect(decoded.relays[1].priority).toBe(1);
    expect(bytesToHex(decoded.relays[0].tenant_id)).toBe(bytesToHex(TENANT_ID));
    expect(decoded.log_key).toHaveLength(1);
    expect(decoded.meta_key.epoch).toBe(1);
    expect(bytesToHex(decoded.meta_key.entries[0].node_id)).toBe(NODE_ID);
  });

  it('meta-key round-trip', () => {
    const payload: MetaKeyPayload = {
      epoch: 9,
      entries: [wrapBytes(), wrapBytes('c3'.repeat(16))],
    };
    const decoded = decodeMetaKeyPayload(encodeMetaKeyPayload(payload));
    expect(decoded.epoch).toBe(9);
    expect(decoded.entries.map((entry) => bytesToHex(entry.node_id))).toEqual([
      NODE_ID,
      'c3'.repeat(16),
    ]);
  });

  it('空中继列表可编码（离开中继）', () => {
    const decoded = decodeSetRelaysPayload(
      encodeSetRelaysPayload(setRelaysPayload({ relays: [], log_key: [] }))
    );
    expect(decoded.relays).toEqual([]);
  });

  it('WrapEntry wire ↔ bytes 互转', async () => {
    const node = x25519.keygen();
    const entry: WrapEntry = await wrapKeyForNode({
      key: generateTenantKey(),
      nodeId: NODE_ID,
      nodeX25519Pk: node.publicKey,
    });
    expect(wrapEntryFromBytes(wrapEntryToBytes(entry))).toEqual(entry);
  });
});

describe('relay 记录的签名矩阵与版本门禁', () => {
  it('两类记录均可由 root / passkey 签名', () => {
    for (const type of RELAY_RECORD_TYPES) {
      expect(KEY_LOG_SIGNER_MATRIX[type]).toEqual(['root', 'passkey']);
    }
  });

  it('门禁要求 1.1.23 且不允许 force', () => {
    for (const type of RELAY_RECORD_TYPES) {
      expect(KEYLOG_RECORD_COMPAT[type]).toEqual({
        minVersion: MIN_RELAY_RECORD_VERSION,
        allowForce: false,
      });
    }
    expect(MIN_RELAY_RECORD_VERSION).toBe('1.1.23');
  });
});

describe('relay 记录的状态投影', () => {
  it('初始状态没有中继与 meta 世代', () => {
    const initial = state();
    expect(initial.relays).toBeNull();
    expect(initial.metaKeyEpoch).toBe(0);
    expect(initial.metaKeyEntries).toEqual([]);
  });

  it('set-relays 写入有序列表、log_key 条目与 meta 世代', async () => {
    const applied = await commit(state(), 'set-relays', encodeSetRelaysPayload(setRelaysPayload()));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const next = applied.state;
    expect(next.relays?.mode).toBe('ordered');
    expect(next.relays?.relays.map((relay) => relay.url)).toEqual([
      'https://relay-a.example.com',
      'https://relay-b.example.com',
    ]);
    expect(next.relays?.relays[0].tenantId).toBe('bc'.repeat(16));
    expect(encodeBase64url(next.relays?.relays[0].token ?? new Uint8Array())).toBe(
      encodeBase64url(new Uint8Array(32).fill(5))
    );
    expect(next.relays?.logKeyEntries[0].node_id).toBe(NODE_ID);
    expect(next.relays?.seq).toBe(1n);
    expect(next.metaKeyEpoch).toBe(1);
    expect(next.metaKeyEntries[0].node_id).toBe(NODE_ID);
  });

  it('空 relays 表示离开中继', async () => {
    const first = await commit(state(), 'set-relays', encodeSetRelaysPayload(setRelaysPayload()));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const left = await commit(
      first.state,
      'set-relays',
      encodeSetRelaysPayload(
        setRelaysPayload({ relays: [], log_key: [], meta_key: { epoch: 1, entries: [] } })
      )
    );
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    expect(left.state.relays).toBeNull();
    expect(left.state.metaKeyEpoch).toBe(1);
    expect(left.state.metaKeyEntries).toEqual([]);
  });

  it('meta-key 世代必须严格递增', async () => {
    const first = await commit(state(), 'set-relays', encodeSetRelaysPayload(setRelaysPayload()));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const bumped = await commit(
      first.state,
      'meta-key',
      encodeMetaKeyPayload({ epoch: 2, entries: [wrapBytes()] })
    );
    expect(bumped.ok).toBe(true);
    if (!bumped.ok) return;
    expect(bumped.state.metaKeyEpoch).toBe(2);

    const same = await commit(
      bumped.state,
      'meta-key',
      encodeMetaKeyPayload({ epoch: 2, entries: [wrapBytes()] })
    );
    expect(same).toEqual({ ok: false, error: 'relay_epoch_regression' });
    const older = await commit(
      bumped.state,
      'meta-key',
      encodeMetaKeyPayload({ epoch: 1, entries: [wrapBytes()] })
    );
    expect(older).toEqual({ ok: false, error: 'relay_epoch_regression' });
  });

  it('set-relays 允许同世代补发，但不允许回退', async () => {
    const first = await commit(state(), 'set-relays', encodeSetRelaysPayload(setRelaysPayload()));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const bumped = await commit(
      first.state,
      'meta-key',
      encodeMetaKeyPayload({ epoch: 3, entries: [wrapBytes()] })
    );
    expect(bumped.ok).toBe(true);
    if (!bumped.ok) return;

    const same = await commit(
      bumped.state,
      'set-relays',
      encodeSetRelaysPayload(
        setRelaysPayload({
          meta_key: { epoch: 3, entries: [wrapBytes(), wrapBytes('c3'.repeat(16))] },
        })
      )
    );
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.state.metaKeyEpoch).toBe(3);
    expect(same.state.metaKeyEntries).toHaveLength(2);

    const regressed = await commit(
      same.state,
      'set-relays',
      encodeSetRelaysPayload(setRelaysPayload({ meta_key: { epoch: 2, entries: [wrapBytes()] } }))
    );
    expect(regressed).toEqual({ ok: false, error: 'relay_epoch_regression' });
  });

  it('畸形 payload 被拒绝', async () => {
    expect(await commit(state(), 'meta-key', new Uint8Array([1, 2, 3]))).toEqual({
      ok: false,
      error: 'malformed_payload',
    });
    const tooMany = setRelaysPayload({
      relays: Array.from({ length: RELAY_RECORD_MAX_RELAYS + 1 }, (_, i) => ({
        url: `https://r${i}.example.com`,
        tenant_id: TENANT_ID,
        token: new Uint8Array(32),
        priority: 0,
      })),
    });
    expect(await commit(state(), 'set-relays', encodeSetRelaysPayload(tooMany))).toEqual({
      ok: false,
      error: 'malformed_payload',
    });
    const badUrl = setRelaysPayload({
      relays: [
        { url: 'ftp://relay', tenant_id: TENANT_ID, token: new Uint8Array(32), priority: 0 },
      ],
    });
    expect(await commit(state(), 'set-relays', encodeSetRelaysPayload(badUrl))).toEqual({
      ok: false,
      error: 'malformed_payload',
    });
    const entriesWithoutEpoch = encodeMetaKeyPayload({ epoch: 0, entries: [wrapBytes()] });
    expect(await commit(state(), 'meta-key', entriesWithoutEpoch)).toEqual({
      ok: false,
      error: 'malformed_payload',
    });
  });

  it('状态克隆不共享中继列表引用', async () => {
    const first = await commit(state(), 'set-relays', encodeSetRelaysPayload(setRelaysPayload()));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const bumped = await commit(
      first.state,
      'meta-key',
      encodeMetaKeyPayload({ epoch: 5, entries: [] })
    );
    expect(bumped.ok).toBe(true);
    if (!bumped.ok) return;
    expect(first.state.metaKeyEpoch).toBe(1);
    expect(bumped.state.relays).not.toBe(first.state.relays);
    expect(bumped.state.relays?.relays[0].url).toBe('https://relay-a.example.com');
  });

  it('节点能从状态里的条目解出自己的租户密钥', async () => {
    const node = x25519.keygen();
    const logKey = generateTenantKey();
    const metaKey = generateTenantKey();
    const payload = setRelaysPayload({
      log_key: [
        wrapEntryToBytes(
          await wrapKeyForNode({ key: logKey, nodeId: NODE_ID, nodeX25519Pk: node.publicKey })
        ),
      ],
      meta_key: {
        epoch: 1,
        entries: [
          wrapEntryToBytes(
            await wrapKeyForNode({ key: metaKey, nodeId: NODE_ID, nodeX25519Pk: node.publicKey })
          ),
        ],
      },
    });
    const applied = await commit(state(), 'set-relays', encodeSetRelaysPayload(payload));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const logEntry = applied.state.relays?.logKeyEntries[0];
    expect(logEntry).toBeDefined();
    if (!logEntry) return;
    expect(
      encodeBase64url(await unwrapKeyForNode({ entry: logEntry, nodeX25519Sk: node.secretKey }))
    ).toBe(encodeBase64url(logKey));
    expect(
      encodeBase64url(
        await unwrapKeyForNode({
          entry: applied.state.metaKeyEntries[0],
          nodeX25519Sk: node.secretKey,
        })
      )
    ).toBe(encodeBase64url(metaKey));
  });
});
