import { describe, expect, test } from 'bun:test';
import type { UserRecord, UserStore } from '../auth/user-store';
import { meshAuthModeUserFields } from './local-auth-http';

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
  });

  test('passkeySecondFactor is true for any origin once a key exists', () => {
    const store = fakeStore(['https://other.example']);
    const local = meshAuthModeUserFields(fakeUser(), 'http://localhost:19663', store, hub);
    const other = meshAuthModeUserFields(fakeUser(), 'https://other.example', store, hub);
    expect(local.passkeysForThisOrigin).toBe(false);
    expect(local.passkeySecondFactor).toBe(true);
    expect(other.passkeysForThisOrigin).toBe(true);
    expect(other.passkeySecondFactor).toBe(true);
  });

  test('null user does not require a passkey second factor', () => {
    const fields = meshAuthModeUserFields(null, 'http://localhost:19663', fakeStore([]), hub);
    expect(fields.passkeySecondFactor).toBe(false);
    expect(fields.uid).toBeNull();
  });
});
