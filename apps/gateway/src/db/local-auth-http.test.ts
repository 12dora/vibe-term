import { describe, expect, test } from 'bun:test';
import type { UserRecord, UserStore } from '../auth/user-store';
import { meshAuthModeUserFields, secondFactorPolicyForMode } from './local-auth-http';

function fakeUser(overrides?: Partial<UserRecord>): UserRecord {
  return {
    id: 'user-1',
    username: 'alice',
    rootPublicKey: new Uint8Array(32).fill(1),
    rootEpoch: 2,
    kdfParamsJson: '{}',
    totpRecordSeq: null,
    keyLogHeadSeq: 0,
    keyLogHeadHash: new Uint8Array(32),
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function fakeStore(origins: string[]): UserStore {
  return {
    listKeysByUser: () =>
      origins.map((origin, i) => ({
        id: `key-${i}`,
        userId: 'user-1',
        credentialId: Uint8Array.of(i),
        publicKey: new Uint8Array(32),
        rpId: 'localhost',
        origin,
        counter: 0,
        transports: [],
        name: null,
        logSeq: 1,
        createdAt: 0,
      })),
  } as unknown as UserStore;
}

const hub = { nodeId: 'hub', publicUrl: 'https://hub.example' };

describe('meshAuthModeUserFields', () => {
  test('passkeySecondFactor is false when the user has no keys', () => {
    const fields = meshAuthModeUserFields(fakeUser(), 'http://localhost:19663', fakeStore([]), hub);
    expect(fields.passkeySecondFactor).toBe(false);
    expect(fields.passkeysForThisOrigin).toBe(false);
    expect(fields.passkeysRegisteredElsewhere).toBe(false);
    expect(fields.secondFactorPolicy).toBe('none');
  });

  // 二次验证按 origin：别处注册的钥匙在这里做不出断言，要求它等于把用户锁死在门外。
  test('passkeySecondFactor follows the current origin, not any origin', () => {
    const store = fakeStore(['https://other.example']);
    const local = meshAuthModeUserFields(fakeUser(), 'http://localhost:19663', store, hub);
    const other = meshAuthModeUserFields(fakeUser(), 'https://other.example', store, hub);
    expect(local.passkeysForThisOrigin).toBe(false);
    expect(local.passkeySecondFactor).toBe(false);
    expect(local.passkeysRegisteredElsewhere).toBe(true);
    expect(local.secondFactorPolicy).toBe('none');
    expect(other.passkeysForThisOrigin).toBe(true);
    expect(other.passkeySecondFactor).toBe(true);
    expect(other.passkeysRegisteredElsewhere).toBe(false);
    expect(other.secondFactorPolicy).toBe('passkey');
  });

  test('waiver only applies where the origin actually has a key', () => {
    const store = fakeStore(['https://other.example']);
    const here = meshAuthModeUserFields(fakeUser(), 'https://other.example', store, hub, {
      waivePasskeySecondFactor: true,
    });
    expect(here.passkeySecondFactor).toBe(false);
    expect(here.passkeySecondFactorWaived).toBe(true);
    expect(here.secondFactorPolicy).toBe('none');
    const elsewhere = meshAuthModeUserFields(fakeUser(), 'http://localhost:19663', store, hub, {
      waivePasskeySecondFactor: true,
    });
    expect(elsewhere.passkeySecondFactor).toBe(false);
    expect(elsewhere.passkeySecondFactorWaived).toBe(false);
    expect(elsewhere.secondFactorPolicy).toBe('none');
  });

  test('null user does not require a passkey second factor', () => {
    const fields = meshAuthModeUserFields(null, 'http://localhost:19663', fakeStore([]), hub);
    expect(fields.passkeySecondFactor).toBe(false);
    expect(fields.uid).toBeNull();
    expect(fields.secondFactorPolicy).toBe('none');
  });

  test('secondFactorPolicy is either when TOTP and this-origin passkeys are both on', () => {
    const store = fakeStore(['http://localhost:19663']);
    const both = meshAuthModeUserFields(
      fakeUser({ totpRecordSeq: 1 }),
      'http://localhost:19663',
      store,
      hub
    );
    expect(both.totpEnabled).toBe(true);
    expect(both.passkeySecondFactor).toBe(true);
    expect(both.secondFactorPolicy).toBe('either');
    const totpOnly = meshAuthModeUserFields(
      fakeUser({ totpRecordSeq: 1 }),
      'http://localhost:19663',
      fakeStore([]),
      hub
    );
    expect(totpOnly.secondFactorPolicy).toBe('totp');
    const waivedBoth = meshAuthModeUserFields(
      fakeUser({ totpRecordSeq: 1 }),
      'http://localhost:19663',
      store,
      hub,
      { waivePasskeySecondFactor: true }
    );
    expect(waivedBoth.passkeySecondFactor).toBe(false);
    expect(waivedBoth.secondFactorPolicy).toBe('totp');
  });

  test('secondFactorPolicyForMode covers the four published values', () => {
    expect(secondFactorPolicyForMode({ totpEnabled: true, passkeySecondFactor: true })).toBe(
      'either'
    );
    expect(secondFactorPolicyForMode({ totpEnabled: true, passkeySecondFactor: false })).toBe(
      'totp'
    );
    expect(secondFactorPolicyForMode({ totpEnabled: false, passkeySecondFactor: true })).toBe(
      'passkey'
    );
    expect(secondFactorPolicyForMode({ totpEnabled: false, passkeySecondFactor: false })).toBe(
      'none'
    );
  });
});
