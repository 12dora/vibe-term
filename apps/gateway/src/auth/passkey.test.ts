import { describe, expect, test } from 'bun:test';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  DELEGATION_TTL_MS,
  decodeBase64url,
  decodePasskeyAssertion,
  encodeBase64url,
  randomBytes,
  sha256,
} from '@tmex/shared/auth';
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  decodePasskeyAssertionSig,
  encodePasskeyAssertionSig,
  makeVerifyDelegationPasskey,
  makeVerifyPasskeyAssertion,
  verifyAssertion,
  verifyRegistration,
} from './passkey';
import { createEs256Authenticator } from './passkey-test-fixtures';
import { createMigratedAuthDb } from './test-db';
import { UserStore } from './user-store';

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:19663';

describe('passkey', () => {
  test('passkey record sig is Borsh PasskeyAssertion of raw bytes, not JSON', () => {
    const assertion: AuthenticationResponseJSON = {
      id: 'cred-1',
      rawId: 'cred-1',
      type: 'public-key',
      response: {
        clientDataJSON: encodeBase64url(new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa])),
        authenticatorData: encodeBase64url(new Uint8Array([0xbb, 0xbb, 0xbb, 0xbb])),
        signature: encodeBase64url(new Uint8Array([0xcc, 0xcc, 0xcc, 0xcc])),
      },
      clientExtensionResults: {},
    };
    const sig = encodePasskeyAssertionSig(assertion);
    expect(() => JSON.parse(new TextDecoder().decode(sig))).toThrow();
    const decoded = decodePasskeyAssertion(sig);
    expect(decoded.credential_id).toBe('cred-1');
    expect([...decoded.client_data_json]).toEqual([0xaa, 0xaa, 0xaa, 0xaa]);
    expect([...decoded.authenticator_data]).toEqual([0xbb, 0xbb, 0xbb, 0xbb]);
    expect([...decoded.signature]).toEqual([0xcc, 0xcc, 0xcc, 0xcc]);
    const roundTrip = decodePasskeyAssertionSig(sig);
    expect(roundTrip.id).toBe('cred-1');
    expect(roundTrip.rawId).toBe('cred-1');
    expect(roundTrip.response.clientDataJSON).toBe(assertion.response.clientDataJSON);
    expect(roundTrip.response.authenticatorData).toBe(assertion.response.authenticatorData);
    expect(roundTrip.response.signature).toBe(assertion.response.signature);
  });

  test('registration and assertion round-trip with a synthetic ES256 authenticator', async () => {
    const authenticator = await createEs256Authenticator();
    const challenge = randomBytes(32);
    const options = await createRegistrationOptions({
      uid: 'alice',
      userId: 'user-1',
      rpId: RP_ID,
      existingCredentialIds: [],
      challenge,
    });
    expect(options.challenge).toBe(encodeBase64url(challenge));
    expect(options.authenticatorSelection?.userVerification).toBe('required');

    const registration = await authenticator.register({
      challenge,
      rpId: RP_ID,
      origin: ORIGIN,
      counter: 0,
    });
    const payload = await verifyRegistration({
      response: registration,
      expectedChallenge: options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    });
    expect(payload).not.toBeNull();
    if (!payload) {
      throw new Error('registration failed');
    }
    expect(payload.rp_id).toBe(RP_ID);
    expect(payload.origin).toBe(ORIGIN);
    expect(payload.counter).toBe(0);
    expect(payload.credential_id).toBe(encodeBase64url(authenticator.credentialId));
    expect(payload.public_key.length).toBeGreaterThan(64);

    const authChallenge = randomBytes(32);
    const authOptions = await createAuthenticationOptions({
      rpId: RP_ID,
      allowCredentials: [{ id: payload.credential_id, transports: ['internal'] }],
      challenge: authChallenge,
    });
    const assertion0 = await authenticator.assert({
      challenge: authChallenge,
      rpId: RP_ID,
      origin: ORIGIN,
      counter: 0,
    });
    const first = await verifyAssertion({
      response: assertion0,
      expectedChallenge: authOptions.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
      credential: {
        id: payload.credential_id,
        publicKey: payload.public_key,
        counter: 0,
        transports: ['internal'],
      },
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.newCounter).toBe(0);
      expect(first.userVerified).toBe(true);
    }

    const challenge1 = randomBytes(32);
    const assertion1 = await authenticator.assert({
      challenge: challenge1,
      rpId: RP_ID,
      origin: ORIGIN,
      counter: 1,
    });
    const second = await verifyAssertion({
      response: assertion1,
      expectedChallenge: encodeBase64url(challenge1),
      origin: ORIGIN,
      rpId: RP_ID,
      credential: {
        id: payload.credential_id,
        publicKey: payload.public_key,
        counter: 0,
        transports: ['internal'],
      },
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.newCounter).toBe(1);
    }

    const challenge2 = randomBytes(32);
    const assertionReplay = await authenticator.assert({
      challenge: challenge2,
      rpId: RP_ID,
      origin: ORIGIN,
      counter: 1,
    });
    const replay = await verifyAssertion({
      response: assertionReplay,
      expectedChallenge: encodeBase64url(challenge2),
      origin: ORIGIN,
      rpId: RP_ID,
      credential: {
        id: payload.credential_id,
        publicKey: payload.public_key,
        counter: 1,
        transports: ['internal'],
      },
    });
    expect(replay.ok).toBe(false);
  });

  test('makeVerifyPasskeyAssertion and makeVerifyDelegationPasskey use stored origin/rpId', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const users = new UserStore(db);
      users.create({
        id: 'user-1',
        username: 'alice',
        rootPublicKey: new Uint8Array(32).fill(1),
        rootEpoch: 1,
        kdfParamsJson: '{}',
        keyLogHeadSeq: 1,
        keyLogHeadHash: new Uint8Array(32),
        now: 1,
      });
      const authenticator = await createEs256Authenticator();
      const challenge = randomBytes(32);
      const registration = await authenticator.register({
        challenge,
        rpId: RP_ID,
        origin: ORIGIN,
        counter: 0,
      });
      const payload = await verifyRegistration({
        response: registration,
        expectedChallenge: encodeBase64url(challenge),
        origin: ORIGIN,
        rpId: RP_ID,
      });
      if (!payload) {
        throw new Error('registration failed');
      }
      users.insertKey({
        id: 'key-1',
        userId: 'user-1',
        credentialId: decodeBase64url(payload.credential_id),
        publicKey: payload.public_key,
        rpId: payload.rp_id,
        origin: payload.origin,
        counter: payload.counter,
        transports: payload.transports,
        name: 'synth',
        logSeq: 1,
        now: 2,
      });

      const recordBytes = randomBytes(40);
      const recordChallenge = sha256(recordBytes);
      const assertion = await authenticator.assert({
        challenge: recordChallenge,
        rpId: RP_ID,
        origin: ORIGIN,
        counter: 1,
      });
      const verifyRecord = makeVerifyPasskeyAssertion(users);
      const ok = await verifyRecord({
        recordBytes,
        sig: encodePasskeyAssertionSig(assertion),
        credentialId: payload.credential_id,
        publicKey: payload.public_key,
        challenge: recordChallenge,
      });
      expect(ok).toBe(true);
      expect(users.getKeyByCredentialId(decodeBase64url(payload.credential_id))?.counter).toBe(1);

      const delegationChallenge = randomBytes(32);
      const delegationAssertion = await authenticator.assert({
        challenge: delegationChallenge,
        rpId: RP_ID,
        origin: ORIGIN,
        counter: 2,
      });
      const now = 1_700_000_000_000;
      const verifyDelegation = makeVerifyDelegationPasskey(users, { now: () => now });
      const delegated = await verifyDelegation({
        challenge: delegationChallenge,
        delegation: {
          domain: 'tmex/delegation/v1',
          uid: 'user-1',
          sess_pk: new Uint8Array(32),
          issued_at: BigInt(now),
          exp: BigInt(now) + BigInt(DELEGATION_TTL_MS),
          method: 'passkey',
          credential_id: payload.credential_id,
        },
        assertion: delegationAssertion,
        credentialId: payload.credential_id,
      });
      expect(delegated).toBe(true);

      const expiredAssertion = await authenticator.assert({
        challenge: delegationChallenge,
        rpId: RP_ID,
        origin: ORIGIN,
        counter: 3,
      });
      const expired = await verifyDelegation({
        challenge: delegationChallenge,
        delegation: {
          domain: 'tmex/delegation/v1',
          uid: 'user-1',
          sess_pk: new Uint8Array(32),
          issued_at: BigInt(now - DELEGATION_TTL_MS - 1),
          exp: BigInt(now - 1),
          method: 'passkey',
          credential_id: payload.credential_id,
        },
        assertion: expiredAssertion,
        credentialId: payload.credential_id,
      });
      expect(expired).toBe(false);

      const badTtlAssertion = await authenticator.assert({
        challenge: delegationChallenge,
        rpId: RP_ID,
        origin: ORIGIN,
        counter: 4,
      });
      const badTtl = await verifyDelegation({
        challenge: delegationChallenge,
        delegation: {
          domain: 'tmex/delegation/v1',
          uid: 'user-1',
          sess_pk: new Uint8Array(32),
          issued_at: BigInt(now),
          exp: BigInt(now) + 1n,
          method: 'passkey',
          credential_id: payload.credential_id,
        },
        assertion: badTtlAssertion,
        credentialId: payload.credential_id,
      });
      expect(badTtl).toBe(false);

      const jsonAssertion = await authenticator.assert({
        challenge: recordChallenge,
        rpId: RP_ID,
        origin: ORIGIN,
        counter: 5,
      });
      const jsonRejected = await verifyRecord({
        recordBytes,
        sig: new TextEncoder().encode(JSON.stringify(jsonAssertion)),
        credentialId: payload.credential_id,
        publicKey: payload.public_key,
        challenge: recordChallenge,
      });
      expect(jsonRejected).toBe(false);
    } finally {
      close();
    }
  });

  test('verifiers bind stored origin/rpId and reject uid mismatch', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const users = new UserStore(db);
      users.create({
        id: 'user-1',
        username: 'alice',
        rootPublicKey: new Uint8Array(32).fill(1),
        rootEpoch: 1,
        kdfParamsJson: '{}',
        keyLogHeadSeq: 1,
        keyLogHeadHash: new Uint8Array(32),
        now: 1,
      });
      users.create({
        id: 'user-2',
        username: 'bob',
        rootPublicKey: new Uint8Array(32).fill(2),
        rootEpoch: 1,
        kdfParamsJson: '{}',
        keyLogHeadSeq: 1,
        keyLogHeadHash: new Uint8Array(32),
        now: 1,
      });
      const authenticator = await createEs256Authenticator();
      const challenge = randomBytes(32);
      const registration = await authenticator.register({
        challenge,
        rpId: RP_ID,
        origin: ORIGIN,
        counter: 0,
      });
      const payload = await verifyRegistration({
        response: registration,
        expectedChallenge: encodeBase64url(challenge),
        origin: ORIGIN,
        rpId: RP_ID,
      });
      if (!payload) {
        throw new Error('registration failed');
      }
      expect(payload.origin).toBe(ORIGIN);
      expect(payload.rp_id).toBe(RP_ID);
      users.insertKey({
        id: 'key-1',
        userId: 'user-1',
        credentialId: decodeBase64url(payload.credential_id),
        publicKey: payload.public_key,
        rpId: payload.rp_id,
        origin: payload.origin,
        counter: payload.counter,
        transports: payload.transports,
        name: 'synth',
        logSeq: 1,
        now: 2,
      });

      const now = 1_700_000_000_000;
      const verifyDelegation = makeVerifyDelegationPasskey(users, { now: () => now });
      const verifyRecord = makeVerifyPasskeyAssertion(users);
      const delegation = {
        domain: 'tmex/delegation/v1',
        uid: 'user-1',
        sess_pk: new Uint8Array(32),
        issued_at: BigInt(now),
        exp: BigInt(now) + BigInt(DELEGATION_TTL_MS),
        method: 'passkey' as const,
        credential_id: payload.credential_id,
      };

      const foreignOrigin = 'https://other.example:8443';
      const originMismatchChallenge = randomBytes(32);
      const originMismatchAssertion = await authenticator.assert({
        challenge: originMismatchChallenge,
        rpId: RP_ID,
        origin: foreignOrigin,
        counter: 1,
      });
      const originRejected = await verifyDelegation({
        challenge: originMismatchChallenge,
        delegation,
        assertion: originMismatchAssertion,
        credentialId: payload.credential_id,
      });
      expect(originRejected).toBe(false);

      const recordBytes = randomBytes(40);
      const recordChallenge = sha256(recordBytes);
      const recordMismatch = await authenticator.assert({
        challenge: recordChallenge,
        rpId: 'other.example',
        origin: foreignOrigin,
        counter: 2,
      });
      const recordRejected = await verifyRecord({
        recordBytes,
        sig: encodePasskeyAssertionSig(recordMismatch),
        credentialId: payload.credential_id,
        publicKey: payload.public_key,
        challenge: recordChallenge,
      });
      expect(recordRejected).toBe(false);

      const uidMismatchChallenge = randomBytes(32);
      const uidMismatchAssertion = await authenticator.assert({
        challenge: uidMismatchChallenge,
        rpId: RP_ID,
        origin: ORIGIN,
        counter: 3,
      });
      const uidRejected = await verifyDelegation({
        challenge: uidMismatchChallenge,
        delegation: { ...delegation, uid: 'user-2' },
        assertion: uidMismatchAssertion,
        credentialId: payload.credential_id,
      });
      expect(uidRejected).toBe(false);
      expect(users.getKeyByCredentialId(decodeBase64url(payload.credential_id))?.counter).toBe(0);
    } finally {
      close();
    }
  });
});
