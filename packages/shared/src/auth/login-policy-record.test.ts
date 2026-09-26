import { describe, expect, it } from 'bun:test';
import { decodeKeyLogRecord, encodeKeyLogRecord } from './encoding';
import {
  KEYLOG_RECORD_COMPAT,
  KEY_LOG_SIGNER_MATRIX,
  MIN_LOGIN_POLICY_RECORD_VERSION,
  type UserKeyState,
  applyKeyLogRecord,
  emptyUserKeyState,
  genesisHead,
  signKeyLogRecordWithRoot,
  verifyKeyLogRecord,
} from './key-log';
import {
  LOGIN_POLICY_PRESETS,
  applyLoginPolicy,
  buildLoginPolicyRecord,
  decodeLoginPolicyPayload,
  encodeLoginPolicy,
  encodeLoginPolicyPayload,
  loginPolicyFromPreset,
  signLoginPolicyRecordWithRoot,
  standardLoginPolicy,
  validateLoginPolicy,
} from './login-policy-record';
import { rootKeyFromSeed } from './root-key';

const UID = 'user-1';

function root(byte: number) {
  return rootKeyFromSeed(new Uint8Array(32).fill(byte));
}

describe('validateLoginPolicy', () => {
  it('accepts named presets and the standard default', () => {
    expect(validateLoginPolicy(standardLoginPolicy())).toEqual({
      ok: true,
      policy: standardLoginPolicy(),
    });
    expect(validateLoginPolicy(loginPolicyFromPreset('strict', false)).ok).toBe(true);
    expect(LOGIN_POLICY_PRESETS.standard.ipFailThreshold).toBe(10);
    expect(LOGIN_POLICY_PRESETS.relaxed.accountFailPerHour).toBe(100);
    expect(LOGIN_POLICY_PRESETS.strict.ipLockMaxMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('rejects a named preset whose numbers were edited', () => {
    const policy = standardLoginPolicy();
    expect(validateLoginPolicy({ ...policy, ipFailThreshold: 11 }).ok).toBe(false);
  });

  it('enforces custom ranges', () => {
    const custom = {
      preset: 'custom' as const,
      ipFailThreshold: 3,
      ipLockBaseMs: 60_000,
      ipLockMaxMs: 60_000,
      accountFailPerHour: 10,
      accountLockMs: 60_000,
      exemptLocal: false,
    };
    expect(validateLoginPolicy(custom).ok).toBe(true);
    expect(validateLoginPolicy({ ...custom, ipFailThreshold: 2 }).ok).toBe(false);
    expect(validateLoginPolicy({ ...custom, ipLockMaxMs: custom.ipLockBaseMs - 1 }).ok).toBe(false);
    expect(validateLoginPolicy({ ...custom, accountFailPerHour: 9 }).ok).toBe(false);
    expect(validateLoginPolicy({ ...custom, ipLockBaseMs: 59_000 }).ok).toBe(false);
  });
});

describe('login-policy record', () => {
  it('is signed by root or passkey and gated at 2.10.0', () => {
    expect(KEY_LOG_SIGNER_MATRIX['login-policy']).toEqual(['root', 'passkey']);
    expect(KEYLOG_RECORD_COMPAT['login-policy']).toEqual({
      minVersion: MIN_LOGIN_POLICY_RECORD_VERSION,
      failClosedUncached: true,
    });
    expect(MIN_LOGIN_POLICY_RECORD_VERSION).toBe('2.10.0');
  });

  it('root-signs a record whose payload round-trips', () => {
    const signer = root(3);
    const signed = signLoginPolicyRecordWithRoot({
      head: genesisHead(),
      rootEpoch: 0,
      uid: UID,
      policy: loginPolicyFromPreset('relaxed'),
      rootKey: signer,
    });
    const record = decodeKeyLogRecord(signed.bytes);
    expect(record.type).toBe('login-policy');
    expect(record.seq).toBe(1n);
    expect(decodeLoginPolicyPayload(record.payload).preset).toBe('relaxed');
    expect(decodeLoginPolicyPayload(record.payload).exempt_local).toBe(true);
  });

  it('apply stores the policy and rejects a tampered payload', async () => {
    const signer = root(4);
    const state = emptyUserKeyState(signer.publicKey);
    const signed = signLoginPolicyRecordWithRoot({
      head: state.head,
      rootEpoch: state.rootEpoch,
      uid: UID,
      policy: standardLoginPolicy(),
      rootKey: signer,
    });
    const verified = await verifyKeyLogRecord(signed.bytes, signed.sig, {
      head: state.head,
      rootEpoch: state.rootEpoch,
      rootPublicKey: signer.publicKey,
      resolvePasskey: () => null,
      allowGenesis: true,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const applied = await applyKeyLogRecord(state, verified.record, verified.hash);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.state.loginPolicy).toEqual(standardLoginPolicy());

    const bogus = buildLoginPolicyRecord({
      head: genesisHead(),
      rootEpoch: 0,
      uid: UID,
      policy: standardLoginPolicy(),
      signer: 'root',
    });
    bogus.payload = new Uint8Array([1, 2, 3]);
    const bytes = encodeKeyLogRecord(bogus);
    const sig = signKeyLogRecordWithRoot(signer, bytes);
    const again = await verifyKeyLogRecord(bytes, sig, {
      head: genesisHead(),
      rootEpoch: 0,
      rootPublicKey: signer.publicKey,
      resolvePasskey: () => null,
      allowGenesis: true,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(await applyKeyLogRecord(emptyState(signer), again.record, again.hash)).toEqual({
      ok: false,
      error: 'malformed_payload',
    });
  });

  it('applyLoginPolicy rejects an out-of-range custom payload', () => {
    const state = emptyUserKeyState(new Uint8Array(32));
    const record = buildLoginPolicyRecord({
      head: genesisHead(),
      rootEpoch: 0,
      uid: UID,
      policy: standardLoginPolicy(),
      signer: 'root',
    });
    const payload = decodeLoginPolicyPayload(encodeLoginPolicy(standardLoginPolicy()));
    payload.ip_fail_threshold = 1;
    payload.preset = 'custom';
    record.payload = encodeLoginPolicyPayload(payload);
    expect(applyLoginPolicy(state, record)).toEqual({ ok: false, error: 'malformed_payload' });
  });
});

function emptyState(signer: ReturnType<typeof root>): UserKeyState {
  return emptyUserKeyState(signer.publicKey);
}
