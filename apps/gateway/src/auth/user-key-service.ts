import type {
  AddPasskeyPayload,
  ApplyKeyLogError,
  KdfParams,
  KeyLogEffect,
  KeyLogType,
  RootKey,
  StoredNodeCert,
  UserKeyState,
  VerifyKeyLogError,
  VerifyPasskeyAssertion,
} from '@tmex/shared/auth';
import {
  applyKeyLogRecord,
  buildKeyLogRecord,
  decodeBase64url,
  decodeKeyLogRecord,
  decodeResetRootPayload,
  decodeSetTotpPayload,
  deriveSeed,
  encodeBase64url,
  encodeKeyLogRecord,
  encodeResetRootPayload,
  generateKdfParams,
  genesisHead,
  hexToBytes,
  nodeIdToHex,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
  verifyKeyLogChain,
  verifyKeyLogRecord,
} from '@tmex/shared/auth';
import { type KeyLogStore, projectPayloadJson } from './key-log-store';
import type { NodeSessionStore } from './node-session-store';
import type { AuthDb } from './types';
import type { UserStore } from './user-store';

export type ApplyKeyLogInput = {
  bytes: Uint8Array;
  sig: Uint8Array;
};

export type ApplyKeyLogSuccess = {
  ok: true;
  seq: number;
  hash: Uint8Array;
  effects: KeyLogEffect[];
};

export type ApplyKeyLogFailure = {
  ok: false;
  error: VerifyKeyLogError | ApplyKeyLogError | 'unknown_user' | 'malformed_payload';
};

export type ApplyKeyLogServiceResult = ApplyKeyLogSuccess | ApplyKeyLogFailure;

export type ApplyManyResult =
  | { ok: true; applied: number; seq: number; hash: Uint8Array }
  | { ok: false; applied: number; error: string };

export type BootstrapUserResult = {
  userId: string;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  rootKey: RootKey;
};

export type SignAndApplyFields = {
  type: KeyLogType;
  payload: Uint8Array;
};

export type VerifyChainForJoinResult =
  | { ok: true; state: UserKeyState }
  | { ok: false; error: string };

export type UserKeyServiceDeps = {
  db: AuthDb;
  userStore: UserStore;
  keyLogStore: KeyLogStore;
  nodeSessionStore: NodeSessionStore;
  verifyPasskeyAssertion?: VerifyPasskeyAssertion;
};

const ZERO_HASH = new Uint8Array(32);
const DEFAULT_KDF: KdfParams = {
  salt: new Uint8Array(16),
  memory_kib: 65536,
  iterations: 3,
  parallelism: 1,
};

export function kdfParamsToJson(params: KdfParams): string {
  return JSON.stringify({
    salt: encodeBase64url(params.salt),
    memory_kib: params.memory_kib,
    iterations: params.iterations,
    parallelism: params.parallelism,
  });
}

export function kdfParamsFromJson(json: string): KdfParams {
  try {
    const parsed = JSON.parse(json) as {
      salt?: string;
      memory_kib?: number;
      iterations?: number;
      parallelism?: number;
    };
    if (typeof parsed.salt !== 'string') {
      return { ...DEFAULT_KDF, salt: new Uint8Array(DEFAULT_KDF.salt) };
    }
    return {
      salt: decodeBase64url(parsed.salt),
      memory_kib: parsed.memory_kib ?? DEFAULT_KDF.memory_kib,
      iterations: parsed.iterations ?? DEFAULT_KDF.iterations,
      parallelism: parsed.parallelism ?? DEFAULT_KDF.parallelism,
    };
  } catch {
    return { ...DEFAULT_KDF, salt: new Uint8Array(DEFAULT_KDF.salt) };
  }
}

export class UserKeyService {
  private readonly db: AuthDb;
  private readonly userStore: UserStore;
  private readonly keyLogStore: KeyLogStore;
  private readonly nodeSessionStore: NodeSessionStore;
  private readonly verifyPasskeyAssertion?: VerifyPasskeyAssertion;

  constructor(deps: UserKeyServiceDeps) {
    this.db = deps.db;
    this.userStore = deps.userStore;
    this.keyLogStore = deps.keyLogStore;
    this.nodeSessionStore = deps.nodeSessionStore;
    this.verifyPasskeyAssertion = deps.verifyPasskeyAssertion;
  }

  currentState(userId: string): UserKeyState {
    const user = this.userStore.getById(userId);
    if (!user) {
      throw new Error('unknown_user');
    }
    const passkeys = new Map<string, AddPasskeyPayload>();
    for (const key of this.userStore.listKeysByUser(userId)) {
      const credentialId = encodeBase64url(key.credentialId);
      passkeys.set(credentialId, {
        credential_id: credentialId,
        public_key: key.publicKey,
        rp_id: key.rpId,
        origin: key.origin,
        counter: key.counter,
        transports: key.transports,
        backup_eligible: false,
        backup_state: false,
        device_type: 'singleDevice',
        name: key.name ?? '',
      });
    }
    let totp: UserKeyState['totp'] = null;
    if (user.totpRecordSeq != null) {
      const rec = this.keyLogStore.getAtSeq(userId, user.totpRecordSeq);
      if (rec) {
        try {
          totp = decodeSetTotpPayload(decodeKeyLogRecord(rec.bytes).payload);
        } catch {
          totp = null;
        }
      }
    }
    const nodeCerts = new Map<string, StoredNodeCert>();
    for (const cert of this.userStore.listCertsByUser(userId)) {
      let nodeId: Uint8Array;
      try {
        nodeId = hexToBytes(cert.nodeId);
      } catch {
        continue;
      }
      nodeCerts.set(cert.nodeId, {
        nodeId,
        certificateBytes: cert.certificateBytes,
        certSig: cert.certSig,
        authorizationBytes: cert.authorizationBytes,
        authorizationSig: cert.authorizationSig,
        revoked: cert.revokedLogSeq != null,
      });
    }
    return {
      rootPublicKey: user.rootPublicKey,
      rootEpoch: user.rootEpoch,
      kdfParams: kdfParamsFromJson(user.kdfParamsJson),
      passkeys,
      totp,
      nodeCerts,
      head: { seq: BigInt(user.keyLogHeadSeq), hash: user.keyLogHeadHash },
    };
  }

  async apply(userId: string, input: ApplyKeyLogInput): Promise<ApplyKeyLogServiceResult> {
    let record: ReturnType<typeof decodeKeyLogRecord>;
    try {
      record = decodeKeyLogRecord(input.bytes);
    } catch {
      return { ok: false, error: 'malformed_payload' };
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ok: false, error: 'unknown_user' };
    }

    const existing = this.keyLogStore.getAtSeq(userId, Number(record.seq));
    const state = this.currentState(userId);
    const verified = await verifyKeyLogRecord(input.bytes, input.sig, {
      head: state.head,
      rootEpoch: state.rootEpoch,
      rootPublicKey: state.rootPublicKey,
      resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
      verifyPasskeyAssertion: this.verifyPasskeyAssertion,
      existingAtSeq: existing ? { bytes: existing.bytes, sig: existing.sig } : undefined,
      allowGenesis: state.head.seq === 0n,
    });
    if (!verified.ok) {
      return verified;
    }

    const applied = await applyKeyLogRecord(state, verified.record, verified.hash, {
      verifyPasskeyAssertion: this.verifyPasskeyAssertion,
    });
    if (!applied.ok) {
      return applied;
    }

    const now = Date.now();
    try {
      this.db.transaction((tx) => {
        const userStore = new (this.userStore.constructor as typeof UserStore)(tx as AuthDb);
        const keyLogStore = new (this.keyLogStore.constructor as typeof KeyLogStore)(tx as AuthDb);
        const nodeSessionStore = new (this.nodeSessionStore.constructor as typeof NodeSessionStore)(
          tx as AuthDb
        );
        const again = keyLogStore.getAtSeq(userId, Number(verified.record.seq));
        if (again && !bytesEqual(again.bytes, input.bytes)) {
          throw new ForkCollision();
        }
        persistApplied({
          userStore,
          keyLogStore,
          nodeSessionStore,
          userId,
          previous: state,
          next: applied.state,
          record: verified.record,
          bytes: input.bytes,
          sig: input.sig,
          hash: verified.hash,
          effects: applied.effects,
          now,
        });
      });
    } catch (err) {
      if (err instanceof ForkCollision) {
        return { ok: false, error: 'fork' };
      }
      throw err;
    }

    return {
      ok: true,
      seq: Number(verified.record.seq),
      hash: verified.hash,
      effects: applied.effects,
    };
  }

  async applyMany(userId: string, records: ApplyKeyLogInput[]): Promise<ApplyManyResult> {
    if (records.length === 0) {
      const user = this.userStore.getById(userId);
      if (!user) {
        return { ok: false, applied: 0, error: 'unknown_user' };
      }
      return {
        ok: true,
        applied: 0,
        seq: user.keyLogHeadSeq,
        hash: user.keyLogHeadHash,
      };
    }
    let applied = 0;
    let lastSeq = 0;
    let lastHash: Uint8Array = ZERO_HASH;
    for (const record of records) {
      const result = await this.apply(userId, record);
      if (!result.ok) {
        return { ok: false, applied, error: result.error };
      }
      applied += 1;
      lastSeq = result.seq;
      lastHash = result.hash;
    }
    return { ok: true, applied, seq: lastSeq, hash: lastHash };
  }

  async bootstrapUser(input: { username: string; password: string }): Promise<BootstrapUserResult> {
    const kdfParams = generateKdfParams();
    const seed = await deriveSeed(input.password, kdfParams);
    const rootKey = rootKeyFromSeed(seed);
    const now = Date.now();

    let user = this.userStore.getByUsername(input.username);
    if (!user) {
      user = this.userStore.create({
        id: crypto.randomUUID(),
        username: input.username,
        rootPublicKey: rootKey.publicKey,
        rootEpoch: 0,
        kdfParamsJson: kdfParamsToJson(kdfParams),
        totpRecordSeq: null,
        keyLogHeadSeq: 0,
        keyLogHeadHash: ZERO_HASH,
        now,
      });
    }

    const genesisEpoch = user.rootEpoch;
    this.keyLogStore.deleteAll(user.id);
    this.userStore.deleteKeysByUser(user.id);
    this.nodeSessionStore.deleteAllForUser(user.id);
    this.userStore.setTotpRecordSeq(user.id, null, now);
    this.userStore.setKeyLogHead(user.id, { seq: 0, hash: ZERO_HASH, now });
    this.userStore.updateRoot(user.id, {
      rootPublicKey: user.rootPublicKey,
      rootEpoch: genesisEpoch,
      kdfParamsJson: user.kdfParamsJson,
      now,
    });

    const payload = encodeResetRootPayload({
      root_public_key: rootKey.publicKey,
      kdf_params: kdfParams,
    });
    const record = buildKeyLogRecord(genesisHead(), genesisEpoch, {
      uid: user.id,
      type: 'reset-root',
      payload,
      signer: 'root',
      credential_id: null,
    });
    const bytes = encodeKeyLogRecord(record);
    const sig = signKeyLogRecordWithRoot(rootKey, bytes);
    const applied = await this.apply(user.id, { bytes, sig });
    if (!applied.ok) {
      throw new Error(`bootstrap genesis apply failed: ${applied.error}`);
    }

    const next = this.userStore.getById(user.id);
    if (!next) {
      throw new Error('bootstrap user missing after apply');
    }
    return {
      userId: user.id,
      rootPublicKey: next.rootPublicKey,
      rootEpoch: next.rootEpoch,
      rootKey,
    };
  }

  async signAndApply(
    userId: string,
    rootKey: RootKey,
    fields: SignAndApplyFields
  ): Promise<ApplyKeyLogServiceResult> {
    const user = this.userStore.getById(userId);
    if (!user) {
      return { ok: false, error: 'unknown_user' };
    }
    const state = this.currentState(userId);
    const record = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: user.id,
      type: fields.type,
      payload: fields.payload,
      signer: 'root',
      credential_id: null,
    });
    const bytes = encodeKeyLogRecord(record);
    const sig = signKeyLogRecordWithRoot(rootKey, bytes);
    return this.apply(userId, { bytes, sig });
  }

  async verifyChainForJoin(
    records: ApplyKeyLogInput[],
    expectedRootPublicKey: Uint8Array,
    expectedHeadHash: Uint8Array
  ): Promise<VerifyChainForJoinResult> {
    const chain = await verifyKeyLogChain(records, expectedRootPublicKey, expectedHeadHash, {
      verifyPasskeyAssertion: this.verifyPasskeyAssertion,
    });
    if (!chain.ok) {
      return chain;
    }

    let genesisUid: string;
    try {
      genesisUid = decodeKeyLogRecord(records[0]?.bytes ?? new Uint8Array()).uid;
    } catch {
      return { ok: false, error: 'missing_genesis' };
    }

    const existing = this.userStore.getById(genesisUid);
    if (existing && this.keyLogStore.list(genesisUid).length > 0) {
      return { ok: false, error: 'not_empty' };
    }

    const now = Date.now();
    if (!existing) {
      const genesis = decodeKeyLogRecord(records[0].bytes);
      let kdfJson = kdfParamsToJson(DEFAULT_KDF);
      try {
        kdfJson = kdfParamsToJson(decodeResetRootPayload(genesis.payload).kdf_params);
      } catch {
        // keep default
      }
      this.userStore.create({
        id: genesisUid,
        username: genesisUid,
        rootPublicKey: new Uint8Array(32),
        rootEpoch: genesis.root_epoch,
        kdfParamsJson: kdfJson,
        totpRecordSeq: null,
        keyLogHeadSeq: 0,
        keyLogHeadHash: ZERO_HASH,
        now,
      });
    } else {
      this.userStore.setKeyLogHead(genesisUid, { seq: 0, hash: ZERO_HASH, now });
      this.userStore.setTotpRecordSeq(genesisUid, null, now);
    }

    const applied = await this.applyMany(genesisUid, records);
    if (!applied.ok) {
      return { ok: false, error: applied.error };
    }
    return { ok: true, state: this.currentState(genesisUid) };
  }
}

class ForkCollision extends Error {
  constructor() {
    super('fork');
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function persistApplied(args: {
  userStore: UserStore;
  keyLogStore: KeyLogStore;
  nodeSessionStore: NodeSessionStore;
  userId: string;
  previous: UserKeyState;
  next: UserKeyState;
  record: ReturnType<typeof decodeKeyLogRecord>;
  bytes: Uint8Array;
  sig: Uint8Array;
  hash: Uint8Array;
  effects: KeyLogEffect[];
  now: number;
}): void {
  const seq = Number(args.record.seq);
  args.keyLogStore.append({
    userId: args.userId,
    seq,
    prevHash: args.record.prev_hash,
    hash: args.hash,
    rootEpoch: args.record.root_epoch,
    type: args.record.type,
    recordBytes: args.bytes,
    sig: args.sig,
    payloadJson: projectPayloadJson(args.record.type, args.record.payload),
    createdAt: args.now,
  });

  args.userStore.updateRoot(args.userId, {
    rootPublicKey: args.next.rootPublicKey,
    rootEpoch: args.next.rootEpoch,
    kdfParamsJson: kdfParamsToJson(args.next.kdfParams),
    now: args.now,
  });
  args.userStore.setKeyLogHead(args.userId, {
    seq: Number(args.next.head.seq),
    hash: args.next.head.hash,
    now: args.now,
  });

  if (args.record.type === 'rotate-root' || args.record.type === 'reset-root') {
    args.userStore.deleteKeysByUser(args.userId);
    args.userStore.setTotpRecordSeq(args.userId, null, args.now);
    if (args.record.type === 'reset-root') {
      args.userStore.deleteCertsByUser(args.userId);
    }
  } else if (args.record.type === 'set-totp') {
    args.userStore.setTotpRecordSeq(args.userId, seq, args.now);
  } else if (args.record.type === 'clear-totp') {
    args.userStore.setTotpRecordSeq(args.userId, null, args.now);
  }

  if (args.record.type === 'add-passkey') {
    for (const [credentialId, payload] of args.next.passkeys) {
      if (!args.previous.passkeys.has(credentialId)) {
        args.userStore.insertKey({
          id: crypto.randomUUID(),
          userId: args.userId,
          credentialId: decodeBase64url(payload.credential_id),
          publicKey: payload.public_key,
          rpId: payload.rp_id,
          origin: payload.origin,
          counter: payload.counter,
          transports: payload.transports,
          name: payload.name || null,
          logSeq: seq,
          now: args.now,
        });
      }
    }
  } else if (args.record.type === 'remove-passkey') {
    for (const [credentialId] of args.previous.passkeys) {
      if (!args.next.passkeys.has(credentialId)) {
        const row = args.userStore.getKeyByCredentialId(decodeBase64url(credentialId));
        if (row) {
          args.userStore.deleteKey(row.id);
        }
      }
    }
  }

  if (args.record.type === 'admit-node') {
    for (const [hex, cert] of args.next.nodeCerts) {
      const prev = args.previous.nodeCerts.get(hex);
      if (
        !prev ||
        prev.revoked !== cert.revoked ||
        !bytesEqual(prev.certificateBytes, cert.certificateBytes)
      ) {
        args.userStore.upsertCert({
          nodeId: hex,
          userId: args.userId,
          admitRecordSeq: seq,
          certificateBytes: cert.certificateBytes,
          certSig: cert.certSig,
          authorizationBytes: cert.authorizationBytes,
          authorizationSig: cert.authorizationSig,
          revokedLogSeq: cert.revoked ? seq : null,
        });
      }
    }
  } else if (args.record.type === 'revoke-node') {
    for (const [hex, cert] of args.next.nodeCerts) {
      const prev = args.previous.nodeCerts.get(hex);
      if (cert.revoked && prev && !prev.revoked) {
        args.userStore.markCertRevoked(hex, seq);
        args.userStore.deletePeer(hex);
      }
    }
  }

  for (const effect of args.effects) {
    if (effect.type === 'revokeAllSessions') {
      args.nodeSessionStore.revokeAllForUser(args.userId, args.now);
    } else if (effect.type === 'revokeSessionsByCredential') {
      args.nodeSessionStore.revokeByCredential(decodeBase64url(effect.credentialId), args.now);
    } else if (effect.type === 'revokeSessionsVia') {
      args.nodeSessionStore.revokeVia(nodeIdToHex(effect.nodeId), args.now);
    } else if (effect.type === 'clearPeerCache') {
      args.userStore.deleteAllPeers();
    }
  }
}
