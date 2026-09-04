import { describe, expect, test } from 'bun:test';
import {
  buildKeyLogRecord,
  createEnrollment,
  createNodeCertificate,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeKeyLogRecord,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  genesisHead,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
} from '@tmex/shared/auth';
import { verifyRelayMemberProof } from './relay-member';

const UID = 'user-1';

async function signedAdmit(type: 'admit-node' | 'readmit-node', epoch: number) {
  const root = rootKeyFromSeed(new Uint8Array(32).fill(7));
  const enroll = await createEnrollment(root, { uid: UID, rootEpoch: epoch, now: 1 });
  const cert = createNodeCertificate(enroll.enrollSk, {
    uid: UID,
    edPk: generateEd25519KeyPair().publicKey,
    x25519Pk: generateX25519KeyPair().publicKey,
    enrollPk: enroll.enrollPk,
    now: 1,
  });
  const record = buildKeyLogRecord({ seq: 1n, hash: genesisHead().hash }, epoch, {
    uid: UID,
    type,
    payload: encodeAdmitNodePayload({
      authorization_bytes: enroll.authorizationBytes,
      authorization_sig: enroll.authorizationSig,
      certificate_bytes: cert.certificateBytes,
      cert_sig: cert.certSig,
    }),
    signer: 'root',
    credential_id: null,
  });
  const bytes = encodeKeyLogRecord(record);
  const sig = signKeyLogRecordWithRoot(root, bytes);
  return {
    root,
    proof: { bytes: encodeBase64url(bytes), sig: encodeBase64url(sig) },
  };
}

describe('verifyRelayMemberProof readmit-node', () => {
  test('accepts readmit-node at the current epoch for op admit', async () => {
    const { root, proof } = await signedAdmit('readmit-node', 4);
    const result = verifyRelayMemberProof({
      proof,
      op: 'admit',
      rootPublicKey: root.publicKey,
      rootEpoch: 4,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.op).toBe('admit');
  });

  test('rejects an old-epoch admit-node against the current tenant epoch', async () => {
    const { root, proof } = await signedAdmit('admit-node', 1);
    expect(
      verifyRelayMemberProof({
        proof,
        op: 'admit',
        rootPublicKey: root.publicKey,
        rootEpoch: 4,
      })
    ).toEqual({ ok: false, error: 'epoch_mismatch' });
  });
});
