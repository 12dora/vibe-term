import { describe, expect, it } from 'bun:test';
import {
  encodeAddPasskeyPayload,
  encodeAdmitNodePayload,
  encodeKeyLogRecord,
  nodeIdToHex,
  sha256,
} from './encoding';
import { createEnrollment, createNodeCertificate } from './enrollment';
import {
  KEYLOG_RECORD_COMPAT,
  KEY_LOG_SIGNER_MATRIX,
  MIN_NOTIFICATION_SINK_RECORD_VERSION,
  NOTIFICATION_SINK_RECORD_TYPES,
  type UserKeyState,
  applyKeyLogRecord,
  buildKeyLogRecord,
  emptyUserKeyState,
  signKeyLogRecordWithRoot,
  verifyKeyLogRecord,
} from './key-log';
import {
  buildNotificationSinkPayload,
  decodeNotificationSinkPayload,
  encodeNotificationSinkPayload,
} from './notification-sink-record';
import { generateEd25519KeyPair, generateX25519KeyPair, rootKeyFromSeed } from './root-key';

const UID = 'user-1';

const ADD_PASSKEY = encodeAddPasskeyPayload({
  credential_id: 'cred-1',
  public_key: new Uint8Array(8).fill(9),
  rp_id: 'example.com',
  origin: 'https://example.com',
  counter: 0,
  transports: [],
  backup_eligible: false,
  backup_state: false,
  device_type: 'singleDevice',
  name: 'key',
});

function root(byte: number) {
  return rootKeyFromSeed(new Uint8Array(32).fill(byte));
}

async function commit(
  state: UserKeyState,
  signer: ReturnType<typeof root>,
  type: Parameters<typeof buildKeyLogRecord>[2]['type'],
  payload: Uint8Array
) {
  const record = buildKeyLogRecord(state.head, state.rootEpoch, {
    uid: UID,
    type,
    payload,
    signer: 'root',
    credential_id: null,
  });
  const bytes = encodeKeyLogRecord(record);
  const sig = signKeyLogRecordWithRoot(signer, bytes);
  const verified = await verifyKeyLogRecord(bytes, sig, {
    head: state.head,
    rootEpoch: state.rootEpoch,
    rootPublicKey: state.rootPublicKey,
    resolvePasskey: () => null,
  });
  if (!verified.ok) throw new Error(verified.error);
  return applyKeyLogRecord(state, verified.record, verified.hash);
}

async function admit(state: UserKeyState, signer: ReturnType<typeof root>, nodeId: Uint8Array) {
  const enroll = await createEnrollment(signer, { uid: UID, rootEpoch: state.rootEpoch, now: 1 });
  const ed = generateEd25519KeyPair();
  const x = generateX25519KeyPair();
  const cert = createNodeCertificate(enroll.enrollSk, {
    uid: UID,
    edPk: ed.publicKey,
    x25519Pk: x.publicKey,
    enrollPk: enroll.enrollPk,
    now: 1,
    nodeId,
  });
  const applied = await commit(
    state,
    signer,
    'admit-node',
    encodeAdmitNodePayload({
      authorization_bytes: enroll.authorizationBytes,
      authorization_sig: enroll.authorizationSig,
      certificate_bytes: cert.certificateBytes,
      cert_sig: cert.certSig,
    })
  );
  if (!applied.ok) throw new Error(applied.error);
  return applied.state;
}

describe('notification-sink payload', () => {
  it('round-trips through borsh', () => {
    const nodeId = new Uint8Array(16).fill(3);
    const bytes = buildNotificationSinkPayload({ nodeId, enabled: true, at: 1_700_000_000_000 });
    const decoded = decodeNotificationSinkPayload(bytes);
    expect(decoded.node_id).toEqual(nodeId);
    expect(decoded.enabled).toBe(true);
    expect(decoded.at).toBe(1_700_000_000_000n);
    expect(encodeNotificationSinkPayload(decoded)).toEqual(bytes);
  });

  it('rejects node ids that are not 16 bytes and negative timestamps', () => {
    expect(() =>
      buildNotificationSinkPayload({ nodeId: new Uint8Array(8), enabled: true, at: 1 })
    ).toThrow();
    expect(() =>
      buildNotificationSinkPayload({ nodeId: new Uint8Array(16), enabled: true, at: -1 })
    ).toThrow();
  });
});

describe('notification-sink record', () => {
  it('是用户签名记录：签名者只能是 root / passkey，且带版本门', () => {
    expect(KEY_LOG_SIGNER_MATRIX['notification-sink']).toEqual(['root', 'passkey']);
    expect(NOTIFICATION_SINK_RECORD_TYPES).toEqual(['notification-sink']);
    expect(KEYLOG_RECORD_COMPAT['notification-sink']).toEqual({
      minVersion: MIN_NOTIFICATION_SINK_RECORD_VERSION,
      allowForce: false,
    });
    expect(MIN_NOTIFICATION_SINK_RECORD_VERSION).toBe('1.1.39');
  });

  it('root 签名应用后写入 notificationSinks 投影', async () => {
    const r = root(1);
    const nodeId = new Uint8Array(16).fill(7);
    let state = emptyUserKeyState(r.publicKey);
    state = await admit(state, r, nodeId);
    const applied = await commit(
      state,
      r,
      'notification-sink',
      buildNotificationSinkPayload({ nodeId, enabled: true, at: 10 })
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.state.notificationSinks?.get(nodeIdToHex(nodeId))).toBe(true);
    // 原状态不被就地改写。
    expect(state.notificationSinks?.size).toBe(0);
  });

  it('同一节点后写的记录覆盖先前声明', async () => {
    const r = root(1);
    const nodeId = new Uint8Array(16).fill(5);
    let state = emptyUserKeyState(r.publicKey);
    state = await admit(state, r, nodeId);
    const on = await commit(
      state,
      r,
      'notification-sink',
      buildNotificationSinkPayload({ nodeId, enabled: true, at: 1 })
    );
    if (!on.ok) throw new Error(on.error);
    const off = await commit(
      on.state,
      r,
      'notification-sink',
      buildNotificationSinkPayload({ nodeId, enabled: false, at: 2 })
    );
    if (!off.ok) throw new Error(off.error);
    expect(off.state.notificationSinks?.get(nodeIdToHex(nodeId))).toBe(false);
  });

  it('未入网节点与畸形 payload 被拒绝', async () => {
    const r = root(1);
    const nodeId = new Uint8Array(16).fill(9);
    let state = emptyUserKeyState(r.publicKey);
    state = await admit(state, r, nodeId);
    expect(
      await commit(
        state,
        r,
        'notification-sink',
        buildNotificationSinkPayload({ nodeId: new Uint8Array(16).fill(1), enabled: true, at: 1 })
      )
    ).toEqual({ ok: false, error: 'unknown_node' });
    expect(await commit(state, r, 'notification-sink', new Uint8Array([1, 2]))).toEqual({
      ok: false,
      error: 'malformed_payload',
    });
  });

  it('passkey 签名可通过验签并应用', async () => {
    const r = root(1);
    const nodeId = new Uint8Array(16).fill(8);
    let state = emptyUserKeyState(r.publicKey);
    const passkeyApplied = await commit(state, r, 'add-passkey', ADD_PASSKEY);
    if (!passkeyApplied.ok) throw new Error(passkeyApplied.error);
    state = await admit(passkeyApplied.state, r, nodeId);
    const record = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'notification-sink',
      payload: buildNotificationSinkPayload({ nodeId, enabled: true, at: 3 }),
      signer: 'passkey',
      credential_id: 'cred-1',
    });
    const bytes = encodeKeyLogRecord(record);
    const challenges: Uint8Array[] = [];
    const verified = await verifyKeyLogRecord(bytes, new Uint8Array(8), {
      head: state.head,
      rootEpoch: state.rootEpoch,
      rootPublicKey: state.rootPublicKey,
      resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
      verifyPasskeyAssertion: async (args) => {
        challenges.push(args.challenge);
        return true;
      },
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(challenges).toEqual([sha256(bytes)]);
    const applied = await applyKeyLogRecord(state, verified.record, verified.hash);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.state.notificationSinks?.get(nodeIdToHex(nodeId))).toBe(true);
  });
});
