import { describe, expect, it } from 'bun:test';
import {
  bytesEqual,
  encodeAddPasskeyPayload,
  encodeAdmitNodePayload,
  encodeClearTotpPayload,
  encodeKeyLogRecord,
  encodeRemovePasskeyPayload,
  encodeRevokeNodePayload,
  encodeRotateRootPayload,
  encodeSetTotpPayload,
  nodeIdToHex,
} from './encoding';
import { createEnrollment, createNodeCertificate } from './enrollment';
import {
  applyKeyLogRecord,
  buildKeyLogRecord,
  computeRecordHash,
  detectFork,
  emptyUserKeyState,
  genesisHead,
  signKeyLogRecordWithRoot,
  verifyKeyLogChain,
  verifyKeyLogRecord,
} from './key-log';
import type { UserKeyState } from './key-log';
import {
  generateEd25519KeyPair,
  generateKdfParams,
  generateX25519KeyPair,
  rootKeyFromSeed,
} from './root-key';

const UID = 'user-1';

function root(byte: number) {
  return rootKeyFromSeed(new Uint8Array(32).fill(byte));
}

async function signAndVerify(
  state: UserKeyState,
  signer: ReturnType<typeof root>,
  record: ReturnType<typeof buildKeyLogRecord>
) {
  const bytes = encodeKeyLogRecord(record);
  const sig = signKeyLogRecordWithRoot(signer, bytes);
  const verified = await verifyKeyLogRecord(bytes, sig, {
    head: state.head,
    rootEpoch: state.rootEpoch,
    rootPublicKey: state.rootPublicKey,
    resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
  });
  return { bytes, sig, verified };
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
  const { verified } = await signAndVerify(state, signer, record);
  expect(verified.ok).toBe(true);
  if (!verified.ok) {
    throw new Error(verified.error);
  }
  const applied = applyKeyLogRecord(state, verified.record, verified.hash);
  expect(applied.ok).toBe(true);
  if (!applied.ok) {
    throw new Error(applied.error);
  }
  return applied;
}

describe('key-log chain', () => {
  it('starts at genesis seq 0 / 32 zero hash', () => {
    const head = genesisHead();
    expect(head.seq).toBe(0n);
    expect(bytesEqual(head.hash, new Uint8Array(32))).toBe(true);
  });

  it('happy path: add-passkey → set-totp → clear-totp → remove-passkey', async () => {
    const r = root(1);
    let state = emptyUserKeyState(r.publicKey, generateKdfParams());
    const added = await commit(
      state,
      r,
      'add-passkey',
      encodeAddPasskeyPayload({
        credential_id: 'cred-1',
        public_key: new Uint8Array(8).fill(9),
        rp_id: 'example.com',
        origin: 'https://example.com',
        counter: 0,
        transports: ['usb'],
        backup_eligible: false,
        backup_state: false,
        device_type: 'singleDevice',
        name: 'key',
      })
    );
    state = added.state;
    expect(state.head.seq).toBe(1n);
    expect(state.passkeys.get('cred-1')?.name).toBe('key');

    const totp = await commit(
      state,
      r,
      'set-totp',
      encodeSetTotpPayload({
        alg: 'A256GCM',
        nonce: new Uint8Array(12).fill(1),
        ciphertext: new Uint8Array(8).fill(2),
        tag: new Uint8Array(16).fill(3),
      })
    );
    state = totp.state;
    expect(state.totp?.alg).toBe('A256GCM');

    state = (await commit(state, r, 'clear-totp', encodeClearTotpPayload())).state;
    expect(state.totp).toBeNull();

    const removed = await commit(
      state,
      r,
      'remove-passkey',
      encodeRemovePasskeyPayload({ credential_id: 'cred-1' })
    );
    expect(removed.state.passkeys.size).toBe(0);
    expect(removed.effects).toEqual([
      { type: 'revokeSessionsByCredential', credentialId: 'cred-1' },
    ]);
  });

  it('rejects seq gap, prev_hash mismatch, and wrong epoch', async () => {
    const r = root(1);
    const state = emptyUserKeyState(r.publicKey);
    const record = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'clear-totp',
      payload: encodeClearTotpPayload(),
      signer: 'root',
      credential_id: null,
    });

    const gapped = { ...record, seq: 2n };
    const { verified: gap } = await signAndVerify(state, r, gapped);
    expect(gap).toEqual({ ok: false, error: 'seq_gap' });

    const badPrev = { ...record, prev_hash: new Uint8Array(32).fill(1) };
    const { verified: prev } = await signAndVerify(state, r, badPrev);
    expect(prev).toEqual({ ok: false, error: 'prev_hash_mismatch' });

    const badEpoch = { ...record, root_epoch: 7 };
    const { verified: epoch } = await signAndVerify(state, r, badEpoch);
    expect(epoch).toEqual({ ok: false, error: 'epoch_mismatch' });
  });

  it('rotate-root switches the verification key and rejects the old root', async () => {
    const oldRoot = root(1);
    const newRoot = root(2);
    let state = emptyUserKeyState(oldRoot.publicKey, {
      salt: new Uint8Array(16).fill(1),
      memory_kib: 65536,
      iterations: 3,
      parallelism: 1,
    });
    state = (
      await commit(
        state,
        oldRoot,
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
      )
    ).state;
    expect(state.passkeys.size).toBe(1);

    const newParams = {
      salt: new Uint8Array(16).fill(9),
      memory_kib: 65536,
      iterations: 3,
      parallelism: 1,
    };
    const rotated = await commit(
      state,
      oldRoot,
      'rotate-root',
      encodeRotateRootPayload({ root_public_key: newRoot.publicKey, kdf_params: newParams })
    );
    state = rotated.state;
    expect(state.rootEpoch).toBe(1);
    expect(bytesEqual(state.rootPublicKey, newRoot.publicKey)).toBe(true);
    expect(state.passkeys.size).toBe(0);
    expect(state.totp).toBeNull();
    expect(rotated.effects).toEqual([{ type: 'revokeAllSessions' }]);

    const stale = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'clear-totp',
      payload: encodeClearTotpPayload(),
      signer: 'root',
      credential_id: null,
    });
    const { verified: staleVerify } = await signAndVerify(state, oldRoot, stale);
    expect(staleVerify).toEqual({ ok: false, error: 'bad_signature' });

    const { verified: fresh } = await signAndVerify(state, newRoot, stale);
    expect(fresh.ok).toBe(true);
  });

  it('detects a fork at the same seq', async () => {
    const r = root(1);
    const state = emptyUserKeyState(r.publicKey);
    const a = buildKeyLogRecord(state.head, 0, {
      uid: UID,
      type: 'clear-totp',
      payload: encodeClearTotpPayload(),
      signer: 'root',
      credential_id: null,
    });
    const b = buildKeyLogRecord(state.head, 0, {
      uid: UID,
      type: 'set-totp',
      payload: encodeSetTotpPayload({
        alg: 'A256GCM',
        nonce: new Uint8Array(12),
        ciphertext: new Uint8Array(1),
        tag: new Uint8Array(16),
      }),
      signer: 'root',
      credential_id: null,
    });
    const aBytes = encodeKeyLogRecord(a);
    const bBytes = encodeKeyLogRecord(b);
    expect(detectFork(aBytes, bBytes)).toBe(true);
    expect(detectFork(aBytes, aBytes)).toBe(false);

    const sig = signKeyLogRecordWithRoot(r, bBytes);
    const verified = await verifyKeyLogRecord(bBytes, sig, {
      head: state.head,
      rootEpoch: 0,
      rootPublicKey: r.publicKey,
      resolvePasskey: () => null,
      existingAtSeq: aBytes,
    });
    expect(verified).toEqual({ ok: false, error: 'fork' });
  });

  it('admit-node stores a cert and rejects wrong enroll_pk / bad auth sig / uid mismatch', async () => {
    const r = root(1);
    let state = emptyUserKeyState(r.publicKey);
    const enroll = await createEnrollment(r, { uid: UID, rootEpoch: 0, now: 1_700_000_000_000 });
    const ed = generateEd25519KeyPair();
    const x = generateX25519KeyPair();
    const cert = createNodeCertificate(enroll.enrollSk, {
      uid: UID,
      edPk: ed.publicKey,
      x25519Pk: x.publicKey,
      enrollPk: enroll.enrollPk,
      now: 1_700_000_000_000,
    });

    const admitted = await commit(
      state,
      r,
      'admit-node',
      encodeAdmitNodePayload({
        authorization_bytes: enroll.authorizationBytes,
        authorization_sig: enroll.authorizationSig,
        certificate_bytes: cert.certificateBytes,
        cert_sig: cert.certSig,
      })
    );
    state = admitted.state;
    const stored = state.nodeCerts.get(nodeIdToHex(cert.nodeId));
    expect(stored?.revoked).toBe(false);

    const otherEnroll = generateEd25519KeyPair();
    const mismatchCert = createNodeCertificate(enroll.enrollSk, {
      uid: UID,
      edPk: ed.publicKey,
      x25519Pk: x.publicKey,
      enrollPk: otherEnroll.publicKey,
      now: 1_700_000_000_000,
    });
    const mismatchRecord = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'admit-node',
      payload: encodeAdmitNodePayload({
        authorization_bytes: enroll.authorizationBytes,
        authorization_sig: enroll.authorizationSig,
        certificate_bytes: mismatchCert.certificateBytes,
        cert_sig: mismatchCert.certSig,
      }),
      signer: 'root',
      credential_id: null,
    });
    const { verified: mismatchVerify } = await signAndVerify(state, r, mismatchRecord);
    expect(mismatchVerify.ok).toBe(true);
    if (mismatchVerify.ok) {
      const applied = applyKeyLogRecord(state, mismatchVerify.record, mismatchVerify.hash);
      expect(applied).toEqual({ ok: false, error: 'enroll_pk_mismatch' });
    }

    const badSigPayload = encodeAdmitNodePayload({
      authorization_bytes: enroll.authorizationBytes,
      authorization_sig: new Uint8Array(64).fill(7),
      certificate_bytes: cert.certificateBytes,
      cert_sig: cert.certSig,
    });
    const badSigRecord = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'admit-node',
      payload: badSigPayload,
      signer: 'root',
      credential_id: null,
    });
    const { verified: badSigVerify } = await signAndVerify(state, r, badSigRecord);
    expect(badSigVerify.ok).toBe(true);
    if (badSigVerify.ok) {
      expect(applyKeyLogRecord(state, badSigVerify.record, badSigVerify.hash)).toEqual({
        ok: false,
        error: 'bad_authorization_sig',
      });
    }

    const uidCert = createNodeCertificate(enroll.enrollSk, {
      uid: 'other-user',
      edPk: ed.publicKey,
      x25519Pk: x.publicKey,
      enrollPk: enroll.enrollPk,
      now: 1_700_000_000_000,
    });
    const uidRecord = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'admit-node',
      payload: encodeAdmitNodePayload({
        authorization_bytes: enroll.authorizationBytes,
        authorization_sig: enroll.authorizationSig,
        certificate_bytes: uidCert.certificateBytes,
        cert_sig: uidCert.certSig,
      }),
      signer: 'root',
      credential_id: null,
    });
    const { verified: uidVerify } = await signAndVerify(state, r, uidRecord);
    expect(uidVerify.ok).toBe(true);
    if (uidVerify.ok) {
      expect(applyKeyLogRecord(state, uidVerify.record, uidVerify.hash)).toEqual({
        ok: false,
        error: 'uid_mismatch',
      });
    }
  });

  it('revoke-node marks the cert and emits revokeSessionsVia', async () => {
    const r = root(1);
    let state = emptyUserKeyState(r.publicKey);
    const enroll = await createEnrollment(r, { uid: UID, rootEpoch: 0, now: 1 });
    const ed = generateEd25519KeyPair();
    const x = generateX25519KeyPair();
    const cert = createNodeCertificate(enroll.enrollSk, {
      uid: UID,
      edPk: ed.publicKey,
      x25519Pk: x.publicKey,
      enrollPk: enroll.enrollPk,
      now: 1,
    });
    state = (
      await commit(
        state,
        r,
        'admit-node',
        encodeAdmitNodePayload({
          authorization_bytes: enroll.authorizationBytes,
          authorization_sig: enroll.authorizationSig,
          certificate_bytes: cert.certificateBytes,
          cert_sig: cert.certSig,
        })
      )
    ).state;

    const revoked = await commit(
      state,
      r,
      'revoke-node',
      encodeRevokeNodePayload({ node_id: cert.nodeId, reason: 'lost' })
    );
    expect(revoked.state.nodeCerts.get(nodeIdToHex(cert.nodeId))?.revoked).toBe(true);
    expect(revoked.effects[0]).toEqual({ type: 'revokeSessionsVia', nodeId: cert.nodeId });
  });

  it('verifyKeyLogChain walks from genesis and switches keys on rotate-root', async () => {
    const oldRoot = root(3);
    const newRoot = root(4);
    const records: { bytes: Uint8Array; sig: Uint8Array }[] = [];
    const kdf = {
      salt: new Uint8Array(16).fill(5),
      memory_kib: 65536,
      iterations: 3,
      parallelism: 1,
    };

    const rec1 = buildKeyLogRecord(genesisHead(), 0, {
      uid: UID,
      type: 'reset-root',
      payload: encodeRotateRootPayload({ root_public_key: oldRoot.publicKey, kdf_params: kdf }),
      signer: 'root',
      credential_id: null,
    });
    const bytes1 = encodeKeyLogRecord(rec1);
    const sig1 = signKeyLogRecordWithRoot(oldRoot, bytes1);
    records.push({ bytes: bytes1, sig: sig1 });

    const rec2 = buildKeyLogRecord({ seq: 1n, hash: computeRecordHash(bytes1, sig1) }, 1, {
      uid: UID,
      type: 'rotate-root',
      payload: encodeRotateRootPayload({
        root_public_key: newRoot.publicKey,
        kdf_params: {
          salt: new Uint8Array(16).fill(5),
          memory_kib: 65536,
          iterations: 3,
          parallelism: 1,
        },
      }),
      signer: 'root',
      credential_id: null,
    });
    const bytes2 = encodeKeyLogRecord(rec2);
    const sig2 = signKeyLogRecordWithRoot(oldRoot, bytes2);
    records.push({ bytes: bytes2, sig: sig2 });

    const rec3 = buildKeyLogRecord({ seq: 2n, hash: computeRecordHash(bytes2, sig2) }, 2, {
      uid: UID,
      type: 'clear-totp',
      payload: encodeClearTotpPayload(),
      signer: 'root',
      credential_id: null,
    });
    const bytes3 = encodeKeyLogRecord(rec3);
    const sig3 = signKeyLogRecordWithRoot(newRoot, bytes3);
    records.push({ bytes: bytes3, sig: sig3 });

    const chain = await verifyKeyLogChain(
      records,
      newRoot.publicKey,
      computeRecordHash(bytes3, sig3)
    );
    expect(chain.ok).toBe(true);
    if (chain.ok) {
      expect(chain.state.rootEpoch).toBe(2);
      expect(bytesEqual(chain.state.rootPublicKey, newRoot.publicKey)).toBe(true);
      expect(chain.state.head.seq).toBe(3n);
    }

    const staleRoot = await verifyKeyLogChain(records, oldRoot.publicKey);
    expect(staleRoot).toEqual({ ok: false, error: 'root_mismatch' });

    const noGenesis = await verifyKeyLogChain(records.slice(1), newRoot.publicKey);
    expect(noGenesis).toEqual({ ok: false, error: 'missing_genesis' });
  });
});
