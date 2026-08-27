import { describe, expect, it } from 'bun:test';
import {
  DOMAIN_AUTHORIZATION,
  DOMAIN_CERTIFICATE,
  DOMAIN_DELEGATION,
  DOMAIN_KEY_LOG,
  DOMAIN_LOGIN,
  DOMAIN_PEER,
  DelegationSchema,
  bytesEqual,
  bytesToHex,
  concatBytes,
  decodeAddPasskeyPayload,
  decodeAdmitNodePayload,
  decodeAuthorization,
  decodeBase64url,
  decodeCertificate,
  decodeClearTotpPayload,
  decodeDelegation,
  decodeKeyLogRecord,
  decodeLogin,
  decodePeerTranscript,
  decodeRemovePasskeyPayload,
  decodeResetRootPayload,
  decodeRevokeNodePayload,
  decodeRotateRootPayload,
  decodeSetTotpPayload,
  decodeTotpAad,
  encodeAddPasskeyPayload,
  encodeAdmitNodePayload,
  encodeAuthorization,
  encodeBase64url,
  encodeCertificate,
  encodeClearTotpPayload,
  encodeDelegation,
  encodeKeyLogRecord,
  encodeLogin,
  encodePeerTranscript,
  encodeRemovePasskeyPayload,
  encodeResetRootPayload,
  encodeRevokeNodePayload,
  encodeRotateRootPayload,
  encodeSetTotpPayload,
  encodeTotpAad,
  hexToBytes,
  randomBytes,
  sha256,
  u32ToLe,
} from './encoding';

const CANONICAL_DELEGATION_HEX =
  '12000000746d65782f64656c65676174696f6e2f763106000000757365722d3102020202020202020202020202020202020202020202020202020202020202020010a5d4e800000000d581d8e80000000000';

const CANONICAL_KEYLOG_HEX =
  '0e000000746d65782f6b65796c6f672f763106000000757365722d3101000000000000000000000000000000000000000000000000000000000000000000000000000000000000000502000000aabb0000';

function fill(n: number, v: number): Uint8Array {
  return new Uint8Array(n).fill(v);
}

describe('encoding helpers', () => {
  it('sha256 is 32 bytes and stable', () => {
    const digest = sha256(new TextEncoder().encode('abc'));
    expect(digest.length).toBe(32);
    expect(bytesToHex(digest)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('hex round-trip and concat/equal', () => {
    const bytes = fill(8, 0xab);
    expect(bytesToHex(hexToBytes(bytesToHex(bytes)))).toBe('abababababababab');
    expect(bytesEqual(concatBytes(fill(2, 1), fill(2, 2)), new Uint8Array([1, 1, 2, 2]))).toBe(
      true
    );
    expect(bytesEqual(fill(2, 1), fill(2, 2))).toBe(false);
  });

  it('base64url encodes without padding and round-trips 96 bytes to 128 chars', () => {
    const raw = fill(96, 0x01);
    const token = encodeBase64url(raw);
    expect(token.length).toBe(128);
    expect(token.includes('+') || token.includes('/') || token.includes('=')).toBe(false);
    expect(bytesEqual(decodeBase64url(token), raw)).toBe(true);
  });

  it('randomBytes uses CSPRNG of requested length', () => {
    const a = randomBytes(16);
    const b = randomBytes(16);
    expect(a.length).toBe(16);
    expect(b.length).toBe(16);
    expect(bytesEqual(a, b)).toBe(false);
  });

  it('u32ToLe is little-endian', () => {
    expect(bytesToHex(u32ToLe(0x01020304))).toBe('04030201');
  });
});

describe('delegation schema', () => {
  const value = {
    domain: DOMAIN_DELEGATION,
    uid: 'user-1',
    sess_pk: fill(32, 2),
    issued_at: 1_000_000_000_000n,
    exp: 1_000_064_800_000n,
    method: 'root' as const,
    credential_id: null,
  };

  it('round-trips and locks byte-exact snapshot', () => {
    const bytes = encodeDelegation(value);
    expect(bytesToHex(bytes)).toBe(CANONICAL_DELEGATION_HEX);
    const decoded = decodeDelegation(bytes);
    expect(decoded.uid).toBe('user-1');
    expect(decoded.method).toBe('root');
    expect(decoded.credential_id).toBeNull();
    expect(decoded.issued_at).toBe(1_000_000_000_000n);
    expect(decoded.exp).toBe(1_000_064_800_000n);
    expect(bytesEqual(decoded.sess_pk, fill(32, 2))).toBe(true);
  });

  it('encodes passkey method as variant 1 and optional credential_id', () => {
    const bytes = encodeDelegation({
      ...value,
      method: 'passkey',
      credential_id: 'cred-1',
    });
    const decoded = decodeDelegation(bytes);
    expect(decoded.method).toBe('passkey');
    expect(decoded.credential_id).toBe('cred-1');
  });

  it('rejects a swapped domain', () => {
    const bytes = DelegationSchema.serialize({ ...value, domain: DOMAIN_LOGIN });
    expect(() => decodeDelegation(bytes)).toThrow(/domain mismatch/);
  });
});

describe('keyLogRecord schema', () => {
  const value = {
    domain: DOMAIN_KEY_LOG,
    uid: 'user-1',
    seq: 1n,
    prev_hash: fill(32, 0),
    root_epoch: 0,
    type: 'admit-node' as const,
    payload: new Uint8Array([0xaa, 0xbb]),
    signer: 'root' as const,
    credential_id: null,
  };

  it('round-trips and locks byte-exact snapshot', () => {
    const bytes = encodeKeyLogRecord(value);
    expect(bytesToHex(bytes)).toBe(CANONICAL_KEYLOG_HEX);
    const decoded = decodeKeyLogRecord(bytes);
    expect(decoded.type).toBe('admit-node');
    expect(decoded.seq).toBe(1n);
    expect(bytesEqual(decoded.payload, new Uint8Array([0xaa, 0xbb]))).toBe(true);
  });

  it('preserves key-log type variant order', () => {
    const types = [
      'add-passkey',
      'remove-passkey',
      'rotate-root',
      'set-totp',
      'clear-totp',
      'admit-node',
      'revoke-node',
      'reset-root',
    ] as const;
    for (let i = 0; i < types.length; i++) {
      const bytes = encodeKeyLogRecord({ ...value, type: types[i] });
      expect(decodeKeyLogRecord(bytes).type).toBe(types[i]);
    }
  });
});

describe('signed-object round-trips', () => {
  it('login', () => {
    const value = {
      domain: DOMAIN_LOGIN,
      challenge_id: 'ch-1',
      nonce: fill(32, 9),
      target: 'node-a',
      target_pk: fill(32, 8),
      uid: 'user-1',
      entry: 'node-e',
    };
    expect(decodeLogin(encodeLogin(value)).challenge_id).toBe('ch-1');
    expect(bytesEqual(decodeLogin(encodeLogin(value)).nonce, fill(32, 9))).toBe(true);
  });

  it('authorization', () => {
    const value = {
      domain: DOMAIN_AUTHORIZATION,
      uid: 'user-1',
      enroll_pk: fill(32, 5),
      exp: 42n,
      root_epoch: 3,
    };
    const decoded = decodeAuthorization(encodeAuthorization(value));
    expect(decoded.root_epoch).toBe(3);
    expect(decoded.exp).toBe(42n);
  });

  it('certificate', () => {
    const value = {
      domain: DOMAIN_CERTIFICATE,
      uid: 'user-1',
      node_id: fill(16, 7),
      ed_pk: fill(32, 1),
      x25519_pk: fill(32, 2),
      enroll_pk: fill(32, 3),
      issued_at: 99n,
    };
    const decoded = decodeCertificate(encodeCertificate(value));
    expect(bytesEqual(decoded.node_id, fill(16, 7))).toBe(true);
    expect(decoded.issued_at).toBe(99n);
  });

  it('peerTranscript with optional hello fields', () => {
    const hello = {
      node_id: fill(16, 1),
      nonce: fill(32, 2),
      eph_x25519_pk: fill(32, 3),
      dtls_fingerprint: { algorithm: 'sha-256', value: 'AA' },
    };
    const helloNull = {
      node_id: fill(16, 4),
      nonce: fill(32, 5),
      eph_x25519_pk: null,
      dtls_fingerprint: null,
    };
    const decoded = decodePeerTranscript(
      encodePeerTranscript({
        domain: DOMAIN_PEER,
        path: 'dc',
        hello_lo: hello,
        hello_hi: helloNull,
      })
    );
    expect(decoded.path).toBe('dc');
    expect(decoded.hello_lo.dtls_fingerprint?.algorithm).toBe('sha-256');
    expect(decoded.hello_hi.eph_x25519_pk).toBeNull();
  });

  it('totpAad', () => {
    const decoded = decodeTotpAad(encodeTotpAad({ uid: 'user-1', root_epoch: 2, seq: 9n }));
    expect(decoded.root_epoch).toBe(2);
    expect(decoded.seq).toBe(9n);
  });
});

describe('key-log payload schemas', () => {
  it('add-passkey / remove-passkey', () => {
    const add = {
      credential_id: 'cred',
      public_key: fill(8, 0xcc),
      rp_id: 'example.com',
      origin: 'https://example.com',
      counter: 4,
      transports: ['usb', 'nfc'],
      backup_eligible: true,
      backup_state: false,
      device_type: 'multiDevice',
      name: 'yubi',
    };
    expect(decodeAddPasskeyPayload(encodeAddPasskeyPayload(add)).transports).toEqual([
      'usb',
      'nfc',
    ]);
    expect(
      decodeRemovePasskeyPayload(encodeRemovePasskeyPayload({ credential_id: 'cred' }))
        .credential_id
    ).toBe('cred');
  });

  it('rotate-root / reset-root share schema', () => {
    const payload = {
      root_public_key: fill(32, 0x11),
      kdf_params: {
        salt: fill(16, 0x22),
        memory_kib: 65536,
        iterations: 3,
        parallelism: 1,
      },
    };
    expect(
      bytesEqual(
        decodeRotateRootPayload(encodeRotateRootPayload(payload)).root_public_key,
        fill(32, 0x11)
      )
    ).toBe(true);
    expect(decodeResetRootPayload(encodeResetRootPayload(payload)).kdf_params.memory_kib).toBe(
      65536
    );
  });

  it('set-totp / clear-totp / admit-node / revoke-node', () => {
    const totp = decodeSetTotpPayload(
      encodeSetTotpPayload({
        alg: 'A256GCM',
        nonce: fill(12, 1),
        ciphertext: fill(8, 2),
        tag: fill(16, 3),
      })
    );
    expect(totp.alg).toBe('A256GCM');
    expect(encodeClearTotpPayload().length).toBe(0);
    expect(decodeClearTotpPayload(new Uint8Array())).toEqual({});

    const admit = decodeAdmitNodePayload(
      encodeAdmitNodePayload({
        authorization_bytes: fill(4, 1),
        authorization_sig: fill(64, 2),
        certificate_bytes: fill(5, 3),
        cert_sig: fill(64, 4),
      })
    );
    expect(admit.authorization_sig.length).toBe(64);

    const revoke = decodeRevokeNodePayload(
      encodeRevokeNodePayload({ node_id: fill(16, 9), reason: 'lost' })
    );
    expect(revoke.reason).toBe('lost');
  });
});
