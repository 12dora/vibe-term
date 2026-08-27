import { describe, expect, it } from 'bun:test';
import { bytesEqual, decodeAuthorization, decodeCertificate } from './encoding';
import {
  JOIN_TOKEN_CHARS,
  createEnrollment,
  createNodeCertificate,
  decodeJoinToken,
  encodeJoinToken,
  verifyNodeCertificate,
} from './enrollment';
import { generateEd25519KeyPair, generateX25519KeyPair, rootKeyFromSeed } from './root-key';

describe('enrollment', () => {
  const root = rootKeyFromSeed(new Uint8Array(32).fill(4));
  const now = 1_700_000_000_000;

  it('createEnrollment signs authorization with the root key', async () => {
    const enroll = await createEnrollment(root, { uid: 'user-1', rootEpoch: 0, now });
    expect(enroll.enrollSk.length).toBe(32);
    expect(enroll.enrollPk.length).toBe(32);
    expect(enroll.authorizationSig.length).toBe(64);
    const auth = decodeAuthorization(enroll.authorizationBytes);
    expect(auth.uid).toBe('user-1');
    expect(auth.exp).toBe(BigInt(now + 10 * 60 * 1000));
    expect(bytesEqual(auth.enroll_pk, enroll.enrollPk)).toBe(true);
  });

  it('join token round-trips at 128 chars / 96 bytes', () => {
    const enrollSk = new Uint8Array(32).fill(1);
    const rootPk = new Uint8Array(32).fill(2);
    const head = new Uint8Array(32).fill(3);
    const token = encodeJoinToken(enrollSk, rootPk, head);
    expect(token.length).toBe(JOIN_TOKEN_CHARS);
    const decoded = decodeJoinToken(token);
    expect(bytesEqual(decoded.enrollSk, enrollSk)).toBe(true);
    expect(bytesEqual(decoded.rootPublicKey, rootPk)).toBe(true);
    expect(bytesEqual(decoded.keyLogHeadHash, head)).toBe(true);
  });

  it('createNodeCertificate is verifiable with enroll_pk', async () => {
    const enroll = await createEnrollment(root, { uid: 'user-1', rootEpoch: 0, now });
    const ed = generateEd25519KeyPair();
    const x = generateX25519KeyPair();
    const cert = createNodeCertificate(enroll.enrollSk, {
      uid: 'user-1',
      edPk: ed.publicKey,
      x25519Pk: x.publicKey,
      enrollPk: enroll.enrollPk,
      now,
    });
    expect(cert.nodeId.length).toBe(16);
    expect(verifyNodeCertificate(cert.certificateBytes, cert.certSig, enroll.enrollPk)).toBe(true);
    expect(verifyNodeCertificate(cert.certificateBytes, cert.certSig, ed.publicKey)).toBe(false);
    const decoded = decodeCertificate(cert.certificateBytes);
    expect(bytesEqual(decoded.node_id, cert.nodeId)).toBe(true);
    expect(bytesEqual(decoded.enroll_pk, enroll.enrollPk)).toBe(true);
  });
});
