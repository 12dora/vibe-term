import { describe, expect, it } from 'bun:test';
import {
  encodeAddPasskeyPayload,
  encodeAdmitNodePayload,
  encodeKeyLogRecord,
  encodeRevokeNodePayload,
  encodeRotateRootKeepPayload,
  nodeIdToHex,
} from './encoding';
import { createEnrollment, createNodeCertificate } from './enrollment';
import {
  applyKeyLogRecord,
  buildKeyLogRecord,
  emptyUserKeyState,
  signKeyLogRecordWithRoot,
  verifyKeyLogRecord,
} from './key-log';
import type { UserKeyState } from './key-log';
import { generateEd25519KeyPair, generateX25519KeyPair, rootKeyFromSeed } from './root-key';

const UID = 'user-1';

function root(byte: number) {
  return rootKeyFromSeed(new Uint8Array(32).fill(byte));
}

async function signAndApply(
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
    resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
  });
  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error(verified.error);
  return applyKeyLogRecord(state, verified.record, verified.hash);
}

async function admitNode(
  state: UserKeyState,
  signer: ReturnType<typeof root>,
  nodeId?: Uint8Array
) {
  const enroll = await createEnrollment(signer, { uid: UID, rootEpoch: state.rootEpoch, now: 1 });
  const ed = generateEd25519KeyPair();
  const x = generateX25519KeyPair();
  const cert = createNodeCertificate(enroll.enrollSk, {
    uid: UID,
    edPk: ed.publicKey,
    x25519Pk: x.publicKey,
    enrollPk: enroll.enrollPk,
    now: 1,
    ...(nodeId ? { nodeId } : {}),
  });
  const payload = encodeAdmitNodePayload({
    authorization_bytes: enroll.authorizationBytes,
    authorization_sig: enroll.authorizationSig,
    certificate_bytes: cert.certificateBytes,
    cert_sig: cert.certSig,
  });
  const applied = await signAndApply(state, signer, 'admit-node', payload);
  expect(applied.ok).toBe(true);
  if (!applied.ok) throw new Error(applied.error);
  return {
    state: applied.state,
    enroll,
    cert,
    payload,
    hex: nodeIdToHex(cert.nodeId),
  };
}

describe('readmit-node', () => {
  it('root 签名：已承认节点替换 authorization，证书不变', async () => {
    const r = root(1);
    const admitted = await admitNode(emptyUserKeyState(r.publicKey), r);
    const next = root(2);
    const rotated = await signAndApply(
      admitted.state,
      r,
      'rotate-root-keep',
      encodeRotateRootKeepPayload({
        root_public_key: next.publicKey,
        kdf_params: {
          salt: new Uint8Array(16).fill(5),
          memory_kib: 65536,
          iterations: 3,
          parallelism: 1,
        },
        totp: null,
      })
    );
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    const newSig = next.sign(admitted.enroll.authorizationBytes);
    expect(new Uint8Array(newSig)).not.toEqual(new Uint8Array(admitted.enroll.authorizationSig));
    const applied = await signAndApply(
      rotated.state,
      next,
      'readmit-node',
      encodeAdmitNodePayload({
        authorization_bytes: admitted.enroll.authorizationBytes,
        authorization_sig: newSig,
        certificate_bytes: admitted.cert.certificateBytes,
        cert_sig: admitted.cert.certSig,
      })
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const stored = applied.state.nodeCerts.get(admitted.hex);
    expect(stored?.certificateBytes).toEqual(admitted.cert.certificateBytes);
    expect(stored?.certSig).toEqual(admitted.cert.certSig);
    expect(stored?.authorizationSig).toEqual(newSig);
    expect(stored?.revoked).toBe(false);
    expect(admitted.state.nodeCerts.get(admitted.hex)?.authorizationSig).toEqual(
      admitted.enroll.authorizationSig
    );
  });

  it('passkey 签名可通过验签并应用', async () => {
    const r = root(1);
    let state = emptyUserKeyState(r.publicKey);
    const added = await signAndApply(
      state,
      r,
      'add-passkey',
      encodeAddPasskeyPayload({
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
      })
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    state = added.state;
    const admitted = await admitNode(state, r);
    const newSig = r.sign(admitted.enroll.authorizationBytes);
    const record = buildKeyLogRecord(admitted.state.head, admitted.state.rootEpoch, {
      uid: UID,
      type: 'readmit-node',
      payload: encodeAdmitNodePayload({
        authorization_bytes: admitted.enroll.authorizationBytes,
        authorization_sig: newSig,
        certificate_bytes: admitted.cert.certificateBytes,
        cert_sig: admitted.cert.certSig,
      }),
      signer: 'passkey',
      credential_id: 'cred-1',
    });
    const bytes = encodeKeyLogRecord(record);
    const verified = await verifyKeyLogRecord(bytes, new Uint8Array(8), {
      head: admitted.state.head,
      rootEpoch: admitted.state.rootEpoch,
      rootPublicKey: admitted.state.rootPublicKey,
      resolvePasskey: (id) => admitted.state.passkeys.get(id)?.public_key ?? null,
      verifyPasskeyAssertion: async () => true,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const applied = await applyKeyLogRecord(admitted.state, verified.record, verified.hash);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.state.nodeCerts.get(admitted.hex)?.authorizationSig).toEqual(newSig);
  });

  it('未知 / 已吊销 / 证书不一致被拒绝', async () => {
    const r = root(1);
    const ghost = await createEnrollment(r, { uid: UID, rootEpoch: 0, now: 1 });
    const ed = generateEd25519KeyPair();
    const x = generateX25519KeyPair();
    const ghostCert = createNodeCertificate(ghost.enrollSk, {
      uid: UID,
      edPk: ed.publicKey,
      x25519Pk: x.publicKey,
      enrollPk: ghost.enrollPk,
      now: 1,
    });
    expect(
      await signAndApply(
        emptyUserKeyState(r.publicKey),
        r,
        'readmit-node',
        encodeAdmitNodePayload({
          authorization_bytes: ghost.authorizationBytes,
          authorization_sig: ghost.authorizationSig,
          certificate_bytes: ghostCert.certificateBytes,
          cert_sig: ghostCert.certSig,
        })
      )
    ).toEqual({ ok: false, error: 'unknown_node' });

    const admitted = await admitNode(emptyUserKeyState(r.publicKey), r);
    const revoked = await signAndApply(
      admitted.state,
      r,
      'revoke-node',
      encodeRevokeNodePayload({ node_id: admitted.cert.nodeId, reason: 'lost' })
    );
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(
      await signAndApply(
        revoked.state,
        r,
        'readmit-node',
        encodeAdmitNodePayload({
          authorization_bytes: admitted.enroll.authorizationBytes,
          authorization_sig: r.sign(admitted.enroll.authorizationBytes),
          certificate_bytes: admitted.cert.certificateBytes,
          cert_sig: admitted.cert.certSig,
        })
      )
    ).toEqual({ ok: false, error: 'node_revoked' });

    const mismatchCert = createNodeCertificate(admitted.enroll.enrollSk, {
      uid: UID,
      edPk: ed.publicKey,
      x25519Pk: x.publicKey,
      enrollPk: admitted.enroll.enrollPk,
      now: 2,
      nodeId: admitted.cert.nodeId,
    });
    expect(
      await signAndApply(
        admitted.state,
        r,
        'readmit-node',
        encodeAdmitNodePayload({
          authorization_bytes: admitted.enroll.authorizationBytes,
          authorization_sig: r.sign(admitted.enroll.authorizationBytes),
          certificate_bytes: mismatchCert.certificateBytes,
          cert_sig: mismatchCert.certSig,
        })
      )
    ).toEqual({ ok: false, error: 'certificate_mismatch' });
  });
});
