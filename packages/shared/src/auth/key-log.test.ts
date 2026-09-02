import { describe, expect, it } from 'bun:test';
import {
  buildAdmitHubPayload,
  buildRetireHubPayload,
  bytesEqual,
  bytesToHex,
  encodeAddPasskeyPayload,
  encodeAdmitNodePayload,
  encodeClearTotpPayload,
  encodeKeyLogRecord,
  encodePasskeyAssertion,
  encodeRemovePasskeyPayload,
  encodeRevokeNodePayload,
  encodeRotateRootKeepPayload,
  encodeRotateRootPayload,
  encodeSetTotpPayload,
  nodeIdToHex,
} from './encoding';
import { createEnrollment, createNodeCertificate } from './enrollment';
import {
  KEYLOG_RECORD_COMPAT,
  KEY_LOG_SIGNER_MATRIX,
  MIN_HUB_AUTH_RECORD_VERSION,
  MIN_ROTATE_ROOT_KEEP_RECORD_VERSION,
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
  const applied = await applyKeyLogRecord(state, verified.record, verified.hash);
  expect(applied.ok).toBe(true);
  if (!applied.ok) {
    throw new Error(applied.error);
  }
  return applied;
}

async function commitFail(
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
  return applyKeyLogRecord(state, verified.record, verified.hash);
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
    const aSig = signKeyLogRecordWithRoot(r, aBytes);
    const bSig = signKeyLogRecordWithRoot(r, bBytes);
    expect(detectFork({ bytes: aBytes, sig: aSig }, { bytes: bBytes, sig: bSig })).toBe(true);
    expect(detectFork({ bytes: aBytes, sig: aSig }, { bytes: aBytes, sig: aSig })).toBe(false);

    const verified = await verifyKeyLogRecord(bBytes, bSig, {
      head: state.head,
      rootEpoch: 0,
      rootPublicKey: r.publicKey,
      resolvePasskey: () => null,
      existingAtSeq: { bytes: aBytes, sig: aSig },
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
      const applied = await applyKeyLogRecord(state, mismatchVerify.record, mismatchVerify.hash);
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
      expect(await applyKeyLogRecord(state, badSigVerify.record, badSigVerify.hash)).toEqual({
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
      expect(await applyKeyLogRecord(state, uidVerify.record, uidVerify.hash)).toEqual({
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

  it('admit-hub stores authorization; retire-hub marks retired; unknown node is rejected', async () => {
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
    const missing = await commitFail(
      state,
      r,
      'admit-hub',
      buildAdmitHubPayload({
        hubNodeId: cert.nodeId,
        publicUrl: 'https://hub.example',
        priority: 200,
      })
    );
    expect(missing).toEqual({ ok: false, error: 'unknown_node' });

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

    const admitted = await commit(
      state,
      r,
      'admit-hub',
      buildAdmitHubPayload({
        hubNodeId: cert.nodeId,
        publicUrl: 'https://hub.example',
        priority: 200,
      })
    );
    state = admitted.state;
    const hex = nodeIdToHex(cert.nodeId);
    expect(state.hubAuthorizations.get(hex)).toEqual({
      status: 'active',
      publicUrl: 'https://hub.example',
      priority: 200,
      seq: state.head.seq,
    });

    const updated = await commit(
      state,
      r,
      'admit-hub',
      buildAdmitHubPayload({ hubNodeId: cert.nodeId, publicUrl: 'https://hub-b.example' })
    );
    state = updated.state;
    expect(state.hubAuthorizations.get(hex)?.publicUrl).toBe('https://hub-b.example');
    expect(state.hubAuthorizations.get(hex)?.priority).toBe(200);

    const retired = await commit(
      state,
      r,
      'retire-hub',
      buildRetireHubPayload({ hubNodeId: cert.nodeId })
    );
    expect(retired.state.hubAuthorizations.get(hex)?.status).toBe('retired');

    const unknownRetire = await commitFail(
      emptyUserKeyState(r.publicKey),
      r,
      'retire-hub',
      buildRetireHubPayload({ hubNodeId: new Uint8Array(16).fill(9) })
    );
    expect(unknownRetire).toEqual({ ok: false, error: 'unknown_node' });
  });

  it('revoke-node of an admitted hub also retires the authorization', async () => {
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
    state = (await commit(state, r, 'admit-hub', buildAdmitHubPayload({ hubNodeId: cert.nodeId })))
      .state;
    const revoked = await commit(
      state,
      r,
      'revoke-node',
      encodeRevokeNodePayload({ node_id: cert.nodeId, reason: 'lost' })
    );
    expect(revoked.state.hubAuthorizations.get(nodeIdToHex(cert.nodeId))?.status).toBe('retired');
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

const ADD_PASSKEY = encodeAddPasskeyPayload({
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
});

const KDF = {
  salt: new Uint8Array(16).fill(5),
  memory_kib: 65536,
  iterations: 3,
  parallelism: 1,
};

describe('reset-root is genesis only', () => {
  it('rejects reset-root without allowGenesis even at seq 1', async () => {
    const attacker = root(9);
    const state = emptyUserKeyState(root(1).publicKey);
    const record = buildKeyLogRecord(state.head, 0, {
      uid: UID,
      type: 'reset-root',
      payload: encodeRotateRootPayload({
        root_public_key: attacker.publicKey,
        kdf_params: KDF,
      }),
      signer: 'root',
      credential_id: null,
    });
    const bytes = encodeKeyLogRecord(record);
    const sig = signKeyLogRecordWithRoot(attacker, bytes);
    const denied = await verifyKeyLogRecord(bytes, sig, {
      head: state.head,
      rootEpoch: 0,
      rootPublicKey: state.rootPublicKey,
      resolvePasskey: () => null,
    });
    expect(denied).toEqual({ ok: false, error: 'reset_not_genesis' });

    const allowed = await verifyKeyLogRecord(bytes, sig, {
      head: state.head,
      rootEpoch: 0,
      rootPublicKey: state.rootPublicKey,
      resolvePasskey: () => null,
      allowGenesis: true,
    });
    expect(allowed.ok).toBe(true);
  });

  it('rejects a later self-signed reset-root after any head', async () => {
    const r = root(1);
    const attacker = root(9);
    let state = emptyUserKeyState(r.publicKey);
    state = (await commit(state, r, 'clear-totp', encodeClearTotpPayload())).state;
    const record = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'reset-root',
      payload: encodeRotateRootPayload({
        root_public_key: attacker.publicKey,
        kdf_params: KDF,
      }),
      signer: 'root',
      credential_id: null,
    });
    const bytes = encodeKeyLogRecord(record);
    const sig = signKeyLogRecordWithRoot(attacker, bytes);
    const verified = await verifyKeyLogRecord(bytes, sig, {
      head: state.head,
      rootEpoch: state.rootEpoch,
      rootPublicKey: state.rootPublicKey,
      resolvePasskey: () => null,
      allowGenesis: true,
    });
    expect(verified).toEqual({ ok: false, error: 'reset_not_genesis' });
  });

  it('verifyKeyLogChain rejects a second reset-root', async () => {
    const genesisRoot = root(3);
    const attacker = root(9);
    const rec1 = buildKeyLogRecord(genesisHead(), 0, {
      uid: UID,
      type: 'reset-root',
      payload: encodeRotateRootPayload({
        root_public_key: genesisRoot.publicKey,
        kdf_params: KDF,
      }),
      signer: 'root',
      credential_id: null,
    });
    const bytes1 = encodeKeyLogRecord(rec1);
    const sig1 = signKeyLogRecordWithRoot(genesisRoot, bytes1);
    const rec2 = buildKeyLogRecord({ seq: 1n, hash: computeRecordHash(bytes1, sig1) }, 1, {
      uid: UID,
      type: 'reset-root',
      payload: encodeRotateRootPayload({
        root_public_key: attacker.publicKey,
        kdf_params: KDF,
      }),
      signer: 'root',
      credential_id: null,
    });
    const bytes2 = encodeKeyLogRecord(rec2);
    const sig2 = signKeyLogRecordWithRoot(attacker, bytes2);
    const chain = await verifyKeyLogChain(
      [
        { bytes: bytes1, sig: sig1 },
        { bytes: bytes2, sig: sig2 },
      ],
      attacker.publicKey
    );
    expect(chain).toEqual({ ok: false, error: 'reset_not_genesis' });
  });
});

describe('signer matrix', () => {
  it('exports the type/signer table', () => {
    expect(KEY_LOG_SIGNER_MATRIX['rotate-root']).toEqual(['root']);
    expect(KEY_LOG_SIGNER_MATRIX['reset-root']).toEqual(['root']);
    expect(KEY_LOG_SIGNER_MATRIX['rotate-root-keep']).toEqual(['root']);
    expect(KEY_LOG_SIGNER_MATRIX['add-passkey']).toEqual(['root', 'passkey']);
    expect(KEY_LOG_SIGNER_MATRIX['admit-node']).toEqual(['root', 'passkey']);
    expect(KEY_LOG_SIGNER_MATRIX['admit-hub']).toEqual(['root', 'passkey']);
    expect(KEY_LOG_SIGNER_MATRIX['retire-hub']).toEqual(['root', 'passkey']);
    expect(MIN_HUB_AUTH_RECORD_VERSION).toBe('1.1.13');
    expect(MIN_ROTATE_ROOT_KEEP_RECORD_VERSION).toBe('1.1.16');
    expect(KEYLOG_RECORD_COMPAT['admit-hub']?.minVersion).toBe(MIN_HUB_AUTH_RECORD_VERSION);
    expect(KEYLOG_RECORD_COMPAT['retire-hub']?.minVersion).toBe(MIN_HUB_AUTH_RECORD_VERSION);
    expect(KEYLOG_RECORD_COMPAT['rotate-root-keep']?.minVersion).toBe(
      MIN_ROTATE_ROOT_KEEP_RECORD_VERSION
    );
    expect(KEYLOG_RECORD_COMPAT['rotate-root-keep']?.allowForce).toBe(false);
    expect(KEYLOG_RECORD_COMPAT['admit-hub']?.allowForce).toBe(true);
  });

  it('rejects passkey-signed rotate-root before verifying the assertion', async () => {
    const r = root(1);
    const newRoot = root(2);
    let state = emptyUserKeyState(r.publicKey);
    state = (await commit(state, r, 'add-passkey', ADD_PASSKEY)).state;
    const record = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'rotate-root',
      payload: encodeRotateRootPayload({
        root_public_key: newRoot.publicKey,
        kdf_params: KDF,
      }),
      signer: 'passkey',
      credential_id: 'cred-1',
    });
    const bytes = encodeKeyLogRecord(record);
    let hooked = false;
    const verified = await verifyKeyLogRecord(bytes, new Uint8Array(8), {
      head: state.head,
      rootEpoch: state.rootEpoch,
      rootPublicKey: state.rootPublicKey,
      resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
      verifyPasskeyAssertion: async () => {
        hooked = true;
        return true;
      },
    });
    expect(verified).toEqual({ ok: false, error: 'signer_not_allowed' });
    expect(hooked).toBe(false);
  });
});

describe('fork detection covers sig', () => {
  it('treats identical record bytes with different sigs as a fork', async () => {
    const r = root(1);
    const state = emptyUserKeyState(r.publicKey);
    const record = buildKeyLogRecord(state.head, 0, {
      uid: UID,
      type: 'clear-totp',
      payload: encodeClearTotpPayload(),
      signer: 'root',
      credential_id: null,
    });
    const bytes = encodeKeyLogRecord(record);
    const sigA = signKeyLogRecordWithRoot(r, bytes);
    const sigB = new Uint8Array(sigA);
    sigB[0] ^= 0xff;
    expect(detectFork({ bytes, sig: sigA }, { bytes, sig: sigB })).toBe(true);

    const verified = await verifyKeyLogRecord(bytes, sigB, {
      head: state.head,
      rootEpoch: 0,
      rootPublicKey: r.publicKey,
      resolvePasskey: () => null,
      existingAtSeq: { bytes, sig: sigA },
    });
    expect(verified).toEqual({ ok: false, error: 'fork' });

    const byHash = await verifyKeyLogRecord(bytes, sigB, {
      head: state.head,
      rootEpoch: 0,
      rootPublicKey: r.publicKey,
      resolvePasskey: () => null,
      existingAtSeq: computeRecordHash(bytes, sigA),
    });
    expect(byHash).toEqual({ ok: false, error: 'fork' });
  });

  it('locks computeRecordHash', () => {
    const record = buildKeyLogRecord(genesisHead(), 0, {
      uid: UID,
      type: 'admit-node',
      payload: new Uint8Array([0xaa, 0xbb]),
      signer: 'root',
      credential_id: null,
    });
    const bytes = encodeKeyLogRecord(record);
    expect(bytesToHex(bytes)).toBe(
      '0e000000746d65782f6b65796c6f672f763106000000757365722d3101000000000000000000000000000000000000000000000000000000000000000000000000000000000000000502000000aabb0000'
    );
    expect(bytesToHex(computeRecordHash(bytes, new Uint8Array(64).fill(0xab)))).toBe(
      'fdf7acfc57598139c268e3a2fc8ddcea7fe115081cdf1f62122ef9f49c6b611e'
    );
  });
});

describe('reset-root vs rotate-root membership', () => {
  it('reset-root clears nodeCerts and emits clearPeerCache; rotate-root keeps certs', async () => {
    const r = root(1);
    const newRoot = root(2);
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
    state = (await commit(state, r, 'admit-hub', buildAdmitHubPayload({ hubNodeId: cert.nodeId })))
      .state;
    expect(state.nodeCerts.size).toBe(1);
    expect(state.hubAuthorizations.size).toBe(1);

    const rotated = await commit(
      state,
      r,
      'rotate-root',
      encodeRotateRootPayload({ root_public_key: newRoot.publicKey, kdf_params: KDF })
    );
    expect(rotated.state.nodeCerts.size).toBe(1);
    expect(rotated.state.hubAuthorizations.size).toBe(1);
    expect(rotated.effects).toEqual([{ type: 'revokeAllSessions' }]);

    const resetRecord = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'reset-root',
      payload: encodeRotateRootPayload({
        root_public_key: newRoot.publicKey,
        kdf_params: KDF,
      }),
      signer: 'root',
      credential_id: null,
    });
    const resetHash = computeRecordHash(encodeKeyLogRecord(resetRecord), new Uint8Array(64));
    const reset = await applyKeyLogRecord(state, resetRecord, resetHash);
    expect(reset.ok).toBe(true);
    if (reset.ok) {
      expect(reset.state.nodeCerts.size).toBe(0);
      expect(reset.state.hubAuthorizations.size).toBe(0);
      expect(reset.state.passkeys.size).toBe(0);
      expect(reset.effects).toEqual([{ type: 'revokeAllSessions' }, { type: 'clearPeerCache' }]);
    }
  });
});

const SAMPLE_TOTP = {
  alg: 'A256GCM',
  nonce: new Uint8Array(12).fill(1),
  ciphertext: new Uint8Array(8).fill(2),
  tag: new Uint8Array(16).fill(3),
};

describe('rotate-root-keep', () => {
  it('keeps passkeys, totp, certs and hub auths; emits no effects', async () => {
    const oldRoot = root(1);
    const newRoot = root(2);
    let state = emptyUserKeyState(oldRoot.publicKey);
    state = (await commit(state, oldRoot, 'add-passkey', ADD_PASSKEY)).state;
    state = (await commit(state, oldRoot, 'set-totp', encodeSetTotpPayload(SAMPLE_TOTP))).state;
    const enroll = await createEnrollment(oldRoot, { uid: UID, rootEpoch: 0, now: 1 });
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
        oldRoot,
        'admit-node',
        encodeAdmitNodePayload({
          authorization_bytes: enroll.authorizationBytes,
          authorization_sig: enroll.authorizationSig,
          certificate_bytes: cert.certificateBytes,
          cert_sig: cert.certSig,
        })
      )
    ).state;
    state = (
      await commit(state, oldRoot, 'admit-hub', buildAdmitHubPayload({ hubNodeId: cert.nodeId }))
    ).state;

    const nextSeq = state.head.seq + 1n;
    const wrapped = {
      alg: 'A256GCM',
      nonce: new Uint8Array(12).fill(9),
      ciphertext: new Uint8Array(8).fill(8),
      tag: new Uint8Array(16).fill(7),
    };
    const rotated = await commit(
      state,
      oldRoot,
      'rotate-root-keep',
      encodeRotateRootKeepPayload({
        root_public_key: newRoot.publicKey,
        kdf_params: KDF,
        totp: { root_epoch: state.rootEpoch + 1, seq: nextSeq, payload: wrapped },
      })
    );
    expect(rotated.state.rootEpoch).toBe(1);
    expect(bytesEqual(rotated.state.rootPublicKey, newRoot.publicKey)).toBe(true);
    expect(rotated.state.passkeys.size).toBe(1);
    expect(rotated.state.passkeys.get('cred-1')?.name).toBe('key');
    expect(rotated.state.totp?.alg).toBe('A256GCM');
    expect(bytesEqual(rotated.state.totp?.tag ?? new Uint8Array(), wrapped.tag)).toBe(true);
    expect(rotated.state.nodeCerts.size).toBe(1);
    expect(rotated.state.hubAuthorizations.size).toBe(1);
    expect(rotated.effects).toEqual([]);

    const stale = buildKeyLogRecord(rotated.state.head, rotated.state.rootEpoch, {
      uid: UID,
      type: 'clear-totp',
      payload: encodeClearTotpPayload(),
      signer: 'root',
      credential_id: null,
    });
    const { verified: staleVerify } = await signAndVerify(rotated.state, oldRoot, stale);
    expect(staleVerify).toEqual({ ok: false, error: 'bad_signature' });
    const { verified: fresh } = await signAndVerify(rotated.state, newRoot, stale);
    expect(fresh.ok).toBe(true);
  });

  it('rejects totp=null when TOTP is enabled', async () => {
    const r = root(1);
    const newRoot = root(2);
    let state = emptyUserKeyState(r.publicKey);
    state = (await commit(state, r, 'set-totp', encodeSetTotpPayload(SAMPLE_TOTP))).state;
    const failed = await commitFail(
      state,
      r,
      'rotate-root-keep',
      encodeRotateRootKeepPayload({
        root_public_key: newRoot.publicKey,
        kdf_params: KDF,
        totp: null,
      })
    );
    expect(failed).toEqual({ ok: false, error: 'totp_required' });
    expect(state.totp).not.toBeNull();
  });

  it('rejects nested totp AAD that does not match the new epoch and record seq', async () => {
    const r = root(1);
    const newRoot = root(2);
    let state = emptyUserKeyState(r.publicKey);
    state = (await commit(state, r, 'set-totp', encodeSetTotpPayload(SAMPLE_TOTP))).state;
    const nextSeq = state.head.seq + 1n;
    const badEpoch = await commitFail(
      state,
      r,
      'rotate-root-keep',
      encodeRotateRootKeepPayload({
        root_public_key: newRoot.publicKey,
        kdf_params: KDF,
        totp: { root_epoch: state.rootEpoch, seq: nextSeq, payload: SAMPLE_TOTP },
      })
    );
    expect(badEpoch).toEqual({ ok: false, error: 'malformed_payload' });
    const badSeq = await commitFail(
      state,
      r,
      'rotate-root-keep',
      encodeRotateRootKeepPayload({
        root_public_key: newRoot.publicKey,
        kdf_params: KDF,
        totp: { root_epoch: state.rootEpoch + 1, seq: nextSeq + 1n, payload: SAMPLE_TOTP },
      })
    );
    expect(badSeq).toEqual({ ok: false, error: 'malformed_payload' });
  });

  it('allows totp=null when TOTP was not enabled', async () => {
    const r = root(1);
    const newRoot = root(2);
    const state = emptyUserKeyState(r.publicKey);
    const rotated = await commit(
      state,
      r,
      'rotate-root-keep',
      encodeRotateRootKeepPayload({
        root_public_key: newRoot.publicKey,
        kdf_params: KDF,
        totp: null,
      })
    );
    expect(rotated.state.totp).toBeNull();
    expect(rotated.state.rootEpoch).toBe(1);
    expect(rotated.effects).toEqual([]);
  });

  it('rejects passkey-signed rotate-root-keep before verifying the assertion', async () => {
    const r = root(1);
    const newRoot = root(2);
    let state = emptyUserKeyState(r.publicKey);
    state = (await commit(state, r, 'add-passkey', ADD_PASSKEY)).state;
    const record = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'rotate-root-keep',
      payload: encodeRotateRootKeepPayload({
        root_public_key: newRoot.publicKey,
        kdf_params: KDF,
        totp: null,
      }),
      signer: 'passkey',
      credential_id: 'cred-1',
    });
    const bytes = encodeKeyLogRecord(record);
    let hooked = false;
    const verified = await verifyKeyLogRecord(bytes, new Uint8Array(8), {
      head: state.head,
      rootEpoch: state.rootEpoch,
      rootPublicKey: state.rootPublicKey,
      resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
      verifyPasskeyAssertion: async () => {
        hooked = true;
        return true;
      },
    });
    expect(verified).toEqual({ ok: false, error: 'signer_not_allowed' });
    expect(hooked).toBe(false);
  });

  it('verifyKeyLogChain reconstructs TOTP from rotate-root-keep', async () => {
    const oldRoot = root(3);
    const newRoot = root(4);
    const records: { bytes: Uint8Array; sig: Uint8Array }[] = [];
    const genesis = buildKeyLogRecord(genesisHead(), 0, {
      uid: UID,
      type: 'reset-root',
      payload: encodeRotateRootPayload({
        root_public_key: oldRoot.publicKey,
        kdf_params: KDF,
      }),
      signer: 'root',
      credential_id: null,
    });
    const genesisBytes = encodeKeyLogRecord(genesis);
    records.push({ bytes: genesisBytes, sig: signKeyLogRecordWithRoot(oldRoot, genesisBytes) });
    const afterGenesis = await applyKeyLogRecord(
      emptyUserKeyState(new Uint8Array(32), undefined, 0),
      genesis,
      computeRecordHash(records[0]!.bytes, records[0]!.sig)
    );
    expect(afterGenesis.ok).toBe(true);
    if (!afterGenesis.ok) throw new Error(afterGenesis.error);

    const totpRecord = buildKeyLogRecord(afterGenesis.state.head, afterGenesis.state.rootEpoch, {
      uid: UID,
      type: 'set-totp',
      payload: encodeSetTotpPayload(SAMPLE_TOTP),
      signer: 'root',
      credential_id: null,
    });
    const totpBytes = encodeKeyLogRecord(totpRecord);
    records.push({ bytes: totpBytes, sig: signKeyLogRecordWithRoot(oldRoot, totpBytes) });
    const afterTotp = await applyKeyLogRecord(
      afterGenesis.state,
      totpRecord,
      computeRecordHash(records[1]!.bytes, records[1]!.sig)
    );
    expect(afterTotp.ok).toBe(true);
    if (!afterTotp.ok) throw new Error(afterTotp.error);

    const wrapped = {
      alg: 'A256GCM',
      nonce: new Uint8Array(12).fill(4),
      ciphertext: new Uint8Array(8).fill(5),
      tag: new Uint8Array(16).fill(6),
    };
    const keep = buildKeyLogRecord(afterTotp.state.head, afterTotp.state.rootEpoch, {
      uid: UID,
      type: 'rotate-root-keep',
      payload: encodeRotateRootKeepPayload({
        root_public_key: newRoot.publicKey,
        kdf_params: KDF,
        totp: {
          root_epoch: afterTotp.state.rootEpoch + 1,
          seq: afterTotp.state.head.seq + 1n,
          payload: wrapped,
        },
      }),
      signer: 'root',
      credential_id: null,
    });
    const keepBytes = encodeKeyLogRecord(keep);
    records.push({ bytes: keepBytes, sig: signKeyLogRecordWithRoot(oldRoot, keepBytes) });

    const chain = await verifyKeyLogChain(records, newRoot.publicKey);
    expect(chain.ok).toBe(true);
    if (chain.ok) {
      expect(chain.state.rootEpoch).toBe(2);
      expect(bytesEqual(chain.state.rootPublicKey, newRoot.publicKey)).toBe(true);
      expect(chain.state.totp?.alg).toBe('A256GCM');
      expect(bytesEqual(chain.state.totp?.tag ?? new Uint8Array(), wrapped.tag)).toBe(true);
    }
  });
});

describe('admit-node node_id reuse', () => {
  it('rejects a second admit of the same node_id, including after revoke', async () => {
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
      nodeId: new Uint8Array(16).fill(7),
    });
    const payload = encodeAdmitNodePayload({
      authorization_bytes: enroll.authorizationBytes,
      authorization_sig: enroll.authorizationSig,
      certificate_bytes: cert.certificateBytes,
      cert_sig: cert.certSig,
    });
    state = (await commit(state, r, 'admit-node', payload)).state;

    const reuseRecord = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'admit-node',
      payload,
      signer: 'root',
      credential_id: null,
    });
    const { verified } = await signAndVerify(state, r, reuseRecord);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(await applyKeyLogRecord(state, verified.record, verified.hash)).toEqual({
        ok: false,
        error: 'node_id_reused',
      });
    }

    state = (
      await commit(
        state,
        r,
        'revoke-node',
        encodeRevokeNodePayload({ node_id: cert.nodeId, reason: 'lost' })
      )
    ).state;
    const reuseAfterRevoke = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'admit-node',
      payload,
      signer: 'root',
      credential_id: null,
    });
    const after = await signAndVerify(state, r, reuseAfterRevoke);
    expect(after.verified.ok).toBe(true);
    if (after.verified.ok) {
      expect(await applyKeyLogRecord(state, after.verified.record, after.verified.hash)).toEqual({
        ok: false,
        error: 'node_id_reused',
      });
    }
  });

  it('revoke-node on an unknown id stays unknown_node', async () => {
    const r = root(1);
    const state = emptyUserKeyState(r.publicKey);
    const record = buildKeyLogRecord(state.head, 0, {
      uid: UID,
      type: 'revoke-node',
      payload: encodeRevokeNodePayload({ node_id: new Uint8Array(16).fill(1), reason: 'gone' }),
      signer: 'root',
      credential_id: null,
    });
    const { verified } = await signAndVerify(state, r, record);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(await applyKeyLogRecord(state, verified.record, verified.hash)).toEqual({
        ok: false,
        error: 'unknown_node',
      });
    }
  });

  it('admits a passkey-signed authorization via verifyPasskeyAssertion', async () => {
    const r = root(1);
    let state = emptyUserKeyState(r.publicKey);
    state = (await commit(state, r, 'add-passkey', ADD_PASSKEY)).state;
    const assertion = encodePasskeyAssertion({
      credential_id: 'cred-1',
      client_data_json: new Uint8Array([1, 2, 3, 4]),
      authenticator_data: new Uint8Array([5, 6, 7, 8]),
      signature: new Uint8Array([9, 10, 11, 12]),
    });
    const enroll = await createEnrollment(
      { credentialId: 'cred-1', sign: () => assertion },
      { uid: UID, rootEpoch: 0, now: 1 }
    );
    const ed = generateEd25519KeyPair();
    const x = generateX25519KeyPair();
    const cert = createNodeCertificate(enroll.enrollSk, {
      uid: UID,
      edPk: ed.publicKey,
      x25519Pk: x.publicKey,
      enrollPk: enroll.enrollPk,
      now: 1,
    });
    const record = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: UID,
      type: 'admit-node',
      payload: encodeAdmitNodePayload({
        authorization_bytes: enroll.authorizationBytes,
        authorization_sig: enroll.authorizationSig,
        certificate_bytes: cert.certificateBytes,
        cert_sig: cert.certSig,
      }),
      signer: 'root',
      credential_id: null,
    });
    const { verified } = await signAndVerify(state, r, record);
    expect(verified.ok).toBe(true);
    if (!verified.ok) {
      throw new Error(verified.error);
    }
    const withoutHook = await applyKeyLogRecord(state, verified.record, verified.hash);
    expect(withoutHook).toEqual({ ok: false, error: 'bad_authorization_sig' });
    const withHook = await applyKeyLogRecord(state, verified.record, verified.hash, {
      verifyPasskeyAssertion: async (args) =>
        args.credentialId === 'cred-1' && bytesEqual(args.sig, assertion),
    });
    expect(withHook.ok).toBe(true);
    if (withHook.ok) {
      expect(withHook.state.nodeCerts.has(nodeIdToHex(cert.nodeId))).toBe(true);
    }
  });
});
