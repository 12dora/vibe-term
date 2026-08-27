import { describe, expect, test } from 'bun:test';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
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

async function createEs256Authenticator() {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const x = decodeBase64url(jwk.x ?? '');
  const y = decodeBase64url(jwk.y ?? '');
  const credentialId = randomBytes(16);
  const coseKey = encodeCoseEs256(x, y);

  return {
    credentialId,
    async register(input: {
      challenge: Uint8Array;
      rpId: string;
      origin: string;
      counter: number;
    }): Promise<RegistrationResponseJSON> {
      const authData = makeAuthData({
        rpId: input.rpId,
        flags: 0x45,
        counter: input.counter,
        attested: {
          aaguid: new Uint8Array(16),
          credentialId,
          coseKey,
        },
      });
      const clientData = makeClientData('webauthn.create', input.challenge, input.origin);
      const attestationObject = cborMap([
        ['fmt', 'none'],
        ['attStmt', EMPTY_MAP],
        ['authData', authData],
      ]);
      const id = encodeBase64url(credentialId);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: encodeBase64url(clientData),
          attestationObject: encodeBase64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      };
    },
    async assert(input: {
      challenge: Uint8Array;
      rpId: string;
      origin: string;
      counter: number;
    }): Promise<AuthenticationResponseJSON> {
      const authData = makeAuthData({
        rpId: input.rpId,
        flags: 0x05,
        counter: input.counter,
      });
      const clientData = makeClientData('webauthn.get', input.challenge, input.origin);
      const signed = concatBytes(authData, sha256(clientData));
      const raw = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keyPair.privateKey,
          signed.slice()
        )
      );
      const id = encodeBase64url(credentialId);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: encodeBase64url(clientData),
          authenticatorData: encodeBase64url(authData),
          signature: encodeBase64url(ieeeP1363ToDer(raw)),
        },
        clientExtensionResults: {},
      };
    },
  };
}

const EMPTY_MAP = Symbol('empty-map');

function encodeCoseEs256(x: Uint8Array, y: Uint8Array): Uint8Array {
  return cborMap([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, x],
    [-3, y],
  ]);
}

function makeClientData(type: string, challenge: Uint8Array, origin: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge: encodeBase64url(challenge),
      origin,
      crossOrigin: false,
    })
  );
}

function makeAuthData(opts: {
  rpId: string;
  flags: number;
  counter: number;
  attested?: { aaguid: Uint8Array; credentialId: Uint8Array; coseKey: Uint8Array };
}): Uint8Array {
  const rpIdHash = sha256(new TextEncoder().encode(opts.rpId));
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, opts.counter >>> 0, false);
  const parts: Uint8Array[] = [rpIdHash, Uint8Array.of(opts.flags), count];
  if (opts.attested) {
    const idLen = new Uint8Array(2);
    new DataView(idLen.buffer).setUint16(0, opts.attested.credentialId.length, false);
    parts.push(opts.attested.aaguid, idLen, opts.attested.credentialId, opts.attested.coseKey);
  }
  return concatBytes(...parts);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function cborHead(major: number, n: number): Uint8Array {
  if (n < 24) {
    return Uint8Array.of((major << 5) | n);
  }
  if (n < 256) {
    return Uint8Array.of((major << 5) | 24, n);
  }
  if (n < 65536) {
    return Uint8Array.of((major << 5) | 25, (n >> 8) & 0xff, n & 0xff);
  }
  throw new Error('cbor length too large');
}

function cborInt(n: number): Uint8Array {
  if (n >= 0) {
    return cborHead(0, n);
  }
  return cborHead(1, -1 - n);
}

function cborBytes(bytes: Uint8Array): Uint8Array {
  return concatBytes(cborHead(2, bytes.length), bytes);
}

function cborText(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  return concatBytes(cborHead(3, encoded.length), encoded);
}

function cborValue(value: unknown): Uint8Array {
  if (value === EMPTY_MAP) {
    return cborHead(5, 0);
  }
  if (value instanceof Uint8Array) {
    return cborBytes(value);
  }
  if (typeof value === 'string') {
    return cborText(value);
  }
  if (typeof value === 'number') {
    return cborInt(value);
  }
  throw new Error('unsupported cbor value');
}

function cborMap(entries: Array<[number | string, unknown]>): Uint8Array {
  const parts: Uint8Array[] = [cborHead(5, entries.length)];
  for (const [key, value] of entries) {
    parts.push(typeof key === 'string' ? cborText(key) : cborInt(key));
    parts.push(cborValue(value));
  }
  return concatBytes(...parts);
}

function ieeeP1363ToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const r = derInt(raw.subarray(0, half));
  const s = derInt(raw.subarray(half));
  const body = concatBytes(Uint8Array.of(0x02, r.length), r, Uint8Array.of(0x02, s.length), s);
  return concatBytes(Uint8Array.of(0x30, body.length), body);
}

function derInt(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start += 1;
  }
  const stripped = bytes.subarray(start);
  if ((stripped[0] ?? 0) & 0x80) {
    return concatBytes(Uint8Array.of(0), stripped);
  }
  return stripped;
}
