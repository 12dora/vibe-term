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
  decodeAddPasskeyPayload,
  decodeAdmitNodePayload,
  decodeBase64url,
  decodeCertificate,
  decodeKeyLogRecord,
  decodeRemovePasskeyPayload,
  decodeResetRootPayload,
  decodeRevokeNodePayload,
  decodeSetTotpPayload,
  deriveSeed,
  detectFork,
  emptyUserKeyState,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeKeyLogRecord,
  encodeResetRootPayload,
  generateKdfParams,
  genesisHead,
  hexToBytes,
  nodeIdToHex,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
  verifyKeyLogRecord,
} from '@tmex/shared/auth';
import { eq } from 'drizzle-orm';
import { encrypt } from '../crypto';
import { nodeIdentity } from '../db/schema';
import { toBuffer } from './binary';
import { type KeyLogStore, projectPayloadJson } from './key-log-store';
import { type NodeIdentityKeys, selfSignedNodeCertificate } from './node-identity-service';
import type { SaveNodeIdentityInput } from './node-identity-store';
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

export type VerifyChainForJoinOptions = {
  anchorHash?: Uint8Array;
};

export type CommitJoinInput = {
  records: ApplyKeyLogInput[];
  expectedRootPublicKey: Uint8Array;
  anchorHash: Uint8Array;
  username: string;
  expectedUserId: string;
  identity?: SaveNodeIdentityInput;
  now?: number;
};

export type BootstrapSelfAdmitInput = {
  username: string;
  password: string;
  identity: NodeIdentityKeys;
  now?: number;
};

type JoinReplayStep = {
  input: ApplyKeyLogInput;
  record: ReturnType<typeof decodeKeyLogRecord>;
  hash: Uint8Array;
  previous: UserKeyState;
  next: UserKeyState;
  effects: KeyLogEffect[];
};

type JoinReplaySuccess = {
  ok: true;
  genesisUid: string;
  state: UserKeyState;
  steps: JoinReplayStep[];
};

const IDENTITY_ROW_ID = 1;

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
    return this.applyInternal(userId, input, { allowGenesis: false });
  }

  private async applyInternal(
    userId: string,
    input: ApplyKeyLogInput,
    opts: { allowGenesis: boolean }
  ): Promise<ApplyKeyLogServiceResult> {
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
      allowGenesis: opts.allowGenesis,
    });
    if (!verified.ok) {
      return verified;
    }

    return this.commitVerified(userId, input, verified.record, verified.hash, state);
  }

  private async commitVerified(
    userId: string,
    input: ApplyKeyLogInput,
    record: ReturnType<typeof decodeKeyLogRecord>,
    hash: Uint8Array,
    previous: UserKeyState
  ): Promise<ApplyKeyLogServiceResult> {
    const applied = await applyKeyLogRecord(previous, record, hash, {
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
        const again = keyLogStore.getAtSeq(userId, Number(record.seq));
        if (
          again &&
          detectFork({ bytes: again.bytes, sig: again.sig }, { bytes: input.bytes, sig: input.sig })
        ) {
          throw new ForkCollision();
        }
        persistApplied({
          userStore,
          keyLogStore,
          nodeSessionStore,
          userId,
          record,
          bytes: input.bytes,
          sig: input.sig,
          hash,
          effects: applied.effects,
          now,
          nextHead: applied.state.head,
          nextRootPublicKey: applied.state.rootPublicKey,
          nextRootEpoch: applied.state.rootEpoch,
          nextKdfParams: applied.state.kdfParams,
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
      seq: Number(record.seq),
      hash,
      effects: applied.effects,
    };
  }

  async applyMany(
    userId: string,
    records: ApplyKeyLogInput[],
    signal?: AbortSignal
  ): Promise<ApplyManyResult> {
    const aborted = (): ApplyManyResult | null => {
      if (!signal?.aborted) return null;
      return { ok: false, applied: 0, error: 'aborted' };
    };
    const early = aborted();
    if (early) return early;
    await Promise.resolve();
    const yielded = aborted();
    if (yielded) return yielded;

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

    const user = this.userStore.getById(userId);
    if (!user) {
      return { ok: false, applied: 0, error: 'unknown_user' };
    }

    type Prepared = {
      input: ApplyKeyLogInput;
      record: ReturnType<typeof decodeKeyLogRecord>;
      hash: Uint8Array;
      effects: KeyLogEffect[];
      nextHead: { seq: bigint; hash: Uint8Array };
      nextRootPublicKey: Uint8Array;
      nextRootEpoch: number;
      nextKdfParams: KdfParams;
    };
    const prepared: Prepared[] = [];
    let state = this.currentState(userId);
    const casHead = { seq: state.head.seq, hash: state.head.hash };

    for (const input of records) {
      const stop = aborted();
      if (stop) return stop;
      let record: ReturnType<typeof decodeKeyLogRecord>;
      try {
        record = decodeKeyLogRecord(input.bytes);
      } catch {
        return { ok: false, applied: 0, error: 'malformed_payload' };
      }
      const existing = this.keyLogStore.getAtSeq(userId, Number(record.seq));
      const verified = await verifyKeyLogRecord(input.bytes, input.sig, {
        head: state.head,
        rootEpoch: state.rootEpoch,
        rootPublicKey: state.rootPublicKey,
        resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
        verifyPasskeyAssertion: this.verifyPasskeyAssertion,
        existingAtSeq: existing ? { bytes: existing.bytes, sig: existing.sig } : undefined,
        allowGenesis: false,
      });
      if (!verified.ok) {
        return { ok: false, applied: 0, error: verified.error };
      }
      const applied = await applyKeyLogRecord(state, verified.record, verified.hash, {
        verifyPasskeyAssertion: this.verifyPasskeyAssertion,
      });
      if (!applied.ok) {
        return { ok: false, applied: 0, error: applied.error };
      }
      prepared.push({
        input,
        record: verified.record,
        hash: verified.hash,
        effects: applied.effects,
        nextHead: {
          seq: applied.state.head.seq,
          hash: new Uint8Array(applied.state.head.hash),
        },
        nextRootPublicKey: new Uint8Array(applied.state.rootPublicKey),
        nextRootEpoch: applied.state.rootEpoch,
        nextKdfParams: applied.state.kdfParams,
      });
      state = applied.state;
    }

    const beforeCommit = aborted();
    if (beforeCommit) return beforeCommit;

    try {
      this.db.transaction((tx) => {
        const userStore = new (this.userStore.constructor as typeof UserStore)(tx as AuthDb);
        const keyLogStore = new (this.keyLogStore.constructor as typeof KeyLogStore)(tx as AuthDb);
        const nodeSessionStore = new (this.nodeSessionStore.constructor as typeof NodeSessionStore)(
          tx as AuthDb
        );
        const current = userStore.getById(userId);
        if (!current) {
          throw new UnknownUser();
        }
        if (
          BigInt(current.keyLogHeadSeq) !== casHead.seq ||
          !bytesEqual(current.keyLogHeadHash, casHead.hash)
        ) {
          throw new HeadCasMismatch();
        }
        const now = Date.now();
        for (const step of prepared) {
          persistApplied({
            userStore,
            keyLogStore,
            nodeSessionStore,
            userId,
            record: step.record,
            bytes: step.input.bytes,
            sig: step.input.sig,
            hash: step.hash,
            effects: step.effects,
            now,
            nextHead: step.nextHead,
            nextRootPublicKey: step.nextRootPublicKey,
            nextRootEpoch: step.nextRootEpoch,
            nextKdfParams: step.nextKdfParams,
          });
        }
      });
    } catch (err) {
      if (err instanceof ForkCollision) {
        return { ok: false, applied: 0, error: 'fork' };
      }
      if (err instanceof HeadCasMismatch) {
        return { ok: false, applied: 0, error: 'head_cas' };
      }
      if (err instanceof UnknownUser) {
        return { ok: false, applied: 0, error: 'unknown_user' };
      }
      throw err;
    }

    const last = prepared[prepared.length - 1];
    if (!last) {
      return { ok: true, applied: 0, seq: Number(casHead.seq), hash: casHead.hash };
    }
    return {
      ok: true,
      applied: prepared.length,
      seq: Number(last.nextHead.seq),
      hash: last.nextHead.hash,
    };
  }

  async head(userId: string, signal?: AbortSignal): Promise<{ seq: bigint; hash: Uint8Array }> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }
    return this.keyLogStore.head(userId) ?? { seq: 0n, hash: ZERO_HASH };
  }

  async list(
    userId: string,
    fromSeq: bigint,
    signal?: AbortSignal,
    limit?: number
  ): Promise<{ seq: bigint; bytes: Uint8Array; sig: Uint8Array }[]> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }
    return this.keyLogStore.list(userId, Number(fromSeq), limit).map((row) => ({
      seq: BigInt(row.seq),
      bytes: row.bytes,
      sig: row.sig,
    }));
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
    const applied = await this.applyInternal(user.id, { bytes, sig }, { allowGenesis: true });
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
    expectedHeadHash: Uint8Array,
    options?: VerifyChainForJoinOptions
  ): Promise<VerifyChainForJoinResult> {
    const replay = await this.replayJoinChain(
      records,
      expectedRootPublicKey,
      options?.anchorHash ?? expectedHeadHash
    );
    if (!replay.ok) {
      return replay;
    }
    return this.persistJoinReplay({
      replay,
      username: replay.genesisUid,
      now: Date.now(),
    });
  }

  async commitJoin(input: CommitJoinInput): Promise<VerifyChainForJoinResult> {
    const replay = await this.replayJoinChain(
      input.records,
      input.expectedRootPublicKey,
      input.anchorHash
    );
    if (!replay.ok) {
      return replay;
    }
    if (replay.genesisUid !== input.expectedUserId) {
      return { ok: false, error: 'uid_mismatch' };
    }
    let encryptedIdentity: EncryptedIdentity | undefined;
    if (input.identity) {
      encryptedIdentity = await encryptIdentity(input.identity);
    }
    return this.persistJoinReplay({
      replay,
      username: input.username,
      now: input.now ?? Date.now(),
      identity: encryptedIdentity,
    });
  }

  async bootstrapUserWithSelfAdmit(input: BootstrapSelfAdmitInput): Promise<BootstrapUserResult> {
    const kdfParams = generateKdfParams();
    const seed = await deriveSeed(input.password, kdfParams);
    const rootKey = rootKeyFromSeed(seed);
    const now = input.now ?? Date.now();
    const existing = this.userStore.getByUsername(input.username);
    const userId = existing?.id ?? crypto.randomUUID();
    const genesisEpoch = existing?.rootEpoch ?? 0;

    const genesisPayload = encodeResetRootPayload({
      root_public_key: rootKey.publicKey,
      kdf_params: kdfParams,
    });
    const genesisRecord = buildKeyLogRecord(genesisHead(), genesisEpoch, {
      uid: userId,
      type: 'reset-root',
      payload: genesisPayload,
      signer: 'root',
      credential_id: null,
    });
    const genesisBytes = encodeKeyLogRecord(genesisRecord);
    const genesisSig = signKeyLogRecordWithRoot(rootKey, genesisBytes);
    const genesisInput: ApplyKeyLogInput = { bytes: genesisBytes, sig: genesisSig };

    let state = emptyUserKeyState(new Uint8Array(32), undefined, genesisEpoch);
    const genesisVerified = await verifyKeyLogRecord(genesisBytes, genesisSig, {
      head: state.head,
      rootEpoch: state.rootEpoch,
      rootPublicKey: state.rootPublicKey,
      resolvePasskey: () => null,
      verifyPasskeyAssertion: this.verifyPasskeyAssertion,
      allowGenesis: true,
    });
    if (!genesisVerified.ok) {
      throw new Error(`bootstrap genesis verify failed: ${genesisVerified.error}`);
    }
    const genesisApplied = await applyKeyLogRecord(
      state,
      genesisVerified.record,
      genesisVerified.hash,
      { verifyPasskeyAssertion: this.verifyPasskeyAssertion }
    );
    if (!genesisApplied.ok) {
      throw new Error(`bootstrap genesis apply failed: ${genesisApplied.error}`);
    }
    const genesisStep: JoinReplayStep = {
      input: genesisInput,
      record: genesisVerified.record,
      hash: genesisVerified.hash,
      previous: state,
      next: genesisApplied.state,
      effects: genesisApplied.effects,
    };
    state = genesisApplied.state;

    const admit = await selfSignedNodeCertificate(input.identity, rootKey, {
      uid: userId,
      rootEpoch: state.rootEpoch,
      now,
    });
    const admitRecord = buildKeyLogRecord(state.head, state.rootEpoch, {
      uid: userId,
      type: 'admit-node',
      payload: encodeAdmitNodePayload(admit),
      signer: 'root',
      credential_id: null,
    });
    const admitBytes = encodeKeyLogRecord(admitRecord);
    const admitSig = signKeyLogRecordWithRoot(rootKey, admitBytes);
    const admitInput: ApplyKeyLogInput = { bytes: admitBytes, sig: admitSig };
    const admitVerified = await verifyKeyLogRecord(admitBytes, admitSig, {
      head: state.head,
      rootEpoch: state.rootEpoch,
      rootPublicKey: state.rootPublicKey,
      resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
      verifyPasskeyAssertion: this.verifyPasskeyAssertion,
    });
    if (!admitVerified.ok) {
      throw new Error(`bootstrap admit-node verify failed: ${admitVerified.error}`);
    }
    const admitApplied = await applyKeyLogRecord(state, admitVerified.record, admitVerified.hash, {
      verifyPasskeyAssertion: this.verifyPasskeyAssertion,
    });
    if (!admitApplied.ok) {
      throw new Error(`bootstrap admit-node apply failed: ${admitApplied.error}`);
    }
    const admitStep: JoinReplayStep = {
      input: admitInput,
      record: admitVerified.record,
      hash: admitVerified.hash,
      previous: state,
      next: admitApplied.state,
      effects: admitApplied.effects,
    };

    this.db.transaction((tx) => {
      const userStore = new (this.userStore.constructor as typeof UserStore)(tx as AuthDb);
      const keyLogStore = new (this.keyLogStore.constructor as typeof KeyLogStore)(tx as AuthDb);
      const nodeSessionStore = new (this.nodeSessionStore.constructor as typeof NodeSessionStore)(
        tx as AuthDb
      );
      if (!existing) {
        userStore.create({
          id: userId,
          username: input.username,
          rootPublicKey: new Uint8Array(32),
          rootEpoch: genesisEpoch,
          kdfParamsJson: kdfParamsToJson(kdfParams),
          totpRecordSeq: null,
          keyLogHeadSeq: 0,
          keyLogHeadHash: ZERO_HASH,
          now,
        });
      } else {
        keyLogStore.deleteAll(userId);
        userStore.deleteKeysByUser(userId);
        nodeSessionStore.deleteAllForUser(userId);
        userStore.deleteCertsByUser(userId);
        userStore.setTotpRecordSeq(userId, null, now);
        userStore.setKeyLogHead(userId, { seq: 0, hash: ZERO_HASH, now });
        userStore.updateRoot(userId, {
          rootPublicKey: new Uint8Array(32),
          rootEpoch: genesisEpoch,
          kdfParamsJson: kdfParamsToJson(kdfParams),
          now,
        });
      }
      persistApplied({
        userStore,
        keyLogStore,
        nodeSessionStore,
        userId,
        record: genesisStep.record,
        bytes: genesisStep.input.bytes,
        sig: genesisStep.input.sig,
        hash: genesisStep.hash,
        effects: genesisStep.effects,
        now,
        nextHead: genesisStep.next.head,
        nextRootPublicKey: genesisStep.next.rootPublicKey,
        nextRootEpoch: genesisStep.next.rootEpoch,
        nextKdfParams: genesisStep.next.kdfParams,
      });
      persistApplied({
        userStore,
        keyLogStore,
        nodeSessionStore,
        userId,
        record: admitStep.record,
        bytes: admitStep.input.bytes,
        sig: admitStep.input.sig,
        hash: admitStep.hash,
        effects: admitStep.effects,
        now,
        nextHead: admitStep.next.head,
        nextRootPublicKey: admitStep.next.rootPublicKey,
        nextRootEpoch: admitStep.next.rootEpoch,
        nextKdfParams: admitStep.next.kdfParams,
      });
      (tx as AuthDb)
        .update(nodeIdentity)
        .set({ userId })
        .where(eq(nodeIdentity.id, IDENTITY_ROW_ID))
        .run();
    });

    const next = this.userStore.getById(userId);
    if (!next) {
      throw new Error('bootstrap user missing after self-admit');
    }
    return {
      userId,
      rootPublicKey: next.rootPublicKey,
      rootEpoch: next.rootEpoch,
      rootKey,
    };
  }

  private async replayJoinChain(
    records: ApplyKeyLogInput[],
    expectedRootPublicKey: Uint8Array,
    anchorHash: Uint8Array
  ): Promise<JoinReplaySuccess | { ok: false; error: string }> {
    const first = records[0];
    if (!first) {
      return { ok: false, error: 'missing_genesis' };
    }
    let genesis: ReturnType<typeof decodeKeyLogRecord>;
    try {
      genesis = decodeKeyLogRecord(first.bytes);
    } catch {
      return { ok: false, error: 'missing_genesis' };
    }
    if (genesis.type !== 'reset-root' || genesis.seq !== 1n) {
      return { ok: false, error: 'missing_genesis' };
    }

    let state = emptyUserKeyState(new Uint8Array(32), undefined, genesis.root_epoch);
    const steps: JoinReplayStep[] = [];
    let anchorFound = false;
    let epochAtAnchor: number | null = null;

    for (let i = 0; i < records.length; i++) {
      const item = records[i];
      if (!item) {
        return { ok: false, error: 'malformed_payload' };
      }
      let decoded: ReturnType<typeof decodeKeyLogRecord>;
      try {
        decoded = decodeKeyLogRecord(item.bytes);
      } catch {
        return { ok: false, error: 'malformed_payload' };
      }
      if (decoded.type === 'reset-root' && i !== 0) {
        return { ok: false, error: 'reset_not_genesis' };
      }
      const verified = await verifyKeyLogRecord(item.bytes, item.sig, {
        head: state.head,
        rootEpoch: state.rootEpoch,
        rootPublicKey: state.rootPublicKey,
        resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
        verifyPasskeyAssertion: this.verifyPasskeyAssertion,
        allowGenesis: i === 0,
      });
      if (!verified.ok) {
        return { ok: false, error: verified.error };
      }
      const applied = await applyKeyLogRecord(state, verified.record, verified.hash, {
        verifyPasskeyAssertion: this.verifyPasskeyAssertion,
      });
      if (!applied.ok) {
        return { ok: false, error: applied.error };
      }
      const hash = verified.hash;
      if (bytesEqual(hash, anchorHash)) {
        anchorFound = true;
        epochAtAnchor = applied.state.rootEpoch;
      } else if (anchorFound) {
        if (decoded.type === 'rotate-root' || decoded.type === 'reset-root') {
          return { ok: false, error: 'epoch_changed' };
        }
        if (epochAtAnchor != null && applied.state.rootEpoch !== epochAtAnchor) {
          return { ok: false, error: 'epoch_changed' };
        }
      }
      steps.push({
        input: item,
        record: verified.record,
        hash,
        previous: state,
        next: applied.state,
        effects: applied.effects,
      });
      state = applied.state;
    }

    if (!anchorFound) {
      return { ok: false, error: 'anchor_missing' };
    }
    if (!bytesEqual(state.rootPublicKey, expectedRootPublicKey)) {
      return { ok: false, error: 'root_mismatch' };
    }
    return { ok: true, genesisUid: genesis.uid, state, steps };
  }

  private persistJoinReplay(args: {
    replay: JoinReplaySuccess;
    username: string;
    now: number;
    identity?: EncryptedIdentity;
  }): VerifyChainForJoinResult {
    const { replay, username, now, identity } = args;
    const genesisUid = replay.genesisUid;
    const existing = this.userStore.getById(genesisUid);
    if (existing && this.keyLogStore.list(genesisUid).length > 0) {
      return { ok: false, error: 'not_empty' };
    }

    const first = replay.steps[0];
    if (!first) {
      return { ok: false, error: 'missing_genesis' };
    }
    let kdfJson = kdfParamsToJson(DEFAULT_KDF);
    try {
      kdfJson = kdfParamsToJson(decodeResetRootPayload(first.record.payload).kdf_params);
    } catch {
      // keep default
    }

    try {
      this.db.transaction((tx) => {
        const userStore = new (this.userStore.constructor as typeof UserStore)(tx as AuthDb);
        const keyLogStore = new (this.keyLogStore.constructor as typeof KeyLogStore)(tx as AuthDb);
        const nodeSessionStore = new (this.nodeSessionStore.constructor as typeof NodeSessionStore)(
          tx as AuthDb
        );
        const again = userStore.getById(genesisUid);
        if (again && keyLogStore.list(genesisUid).length > 0) {
          throw new JoinNotEmpty();
        }
        if (!again) {
          userStore.create({
            id: genesisUid,
            username,
            rootPublicKey: new Uint8Array(32),
            rootEpoch: first.record.root_epoch,
            kdfParamsJson: kdfJson,
            totpRecordSeq: null,
            keyLogHeadSeq: 0,
            keyLogHeadHash: ZERO_HASH,
            now,
          });
        } else {
          userStore.setKeyLogHead(genesisUid, { seq: 0, hash: ZERO_HASH, now });
          userStore.setTotpRecordSeq(genesisUid, null, now);
        }
        for (const step of replay.steps) {
          persistApplied({
            userStore,
            keyLogStore,
            nodeSessionStore,
            userId: genesisUid,
            record: step.record,
            bytes: step.input.bytes,
            sig: step.input.sig,
            hash: step.hash,
            effects: step.effects,
            now,
            nextHead: step.next.head,
            nextRootPublicKey: step.next.rootPublicKey,
            nextRootEpoch: step.next.rootEpoch,
            nextKdfParams: step.next.kdfParams,
          });
        }
        if (identity) {
          persistEncryptedIdentity(tx as AuthDb, identity);
        }
      });
    } catch (err) {
      if (err instanceof JoinNotEmpty) {
        return { ok: false, error: 'not_empty' };
      }
      throw err;
    }
    return { ok: true, state: this.currentState(genesisUid) };
  }
}

class ForkCollision extends Error {
  constructor() {
    super('fork');
  }
}

class HeadCasMismatch extends Error {
  constructor() {
    super('head_cas');
  }
}

class UnknownUser extends Error {
  constructor() {
    super('unknown_user');
  }
}

class JoinNotEmpty extends Error {
  constructor() {
    super('not_empty');
  }
}

type EncryptedIdentity = {
  nodeId: string;
  hubUrl: string | null;
  privateKey: string;
  x25519PrivateKey: string;
  certificateJson: string;
  certSig: Uint8Array;
  userId: string | null;
};

async function encryptIdentity(input: SaveNodeIdentityInput): Promise<EncryptedIdentity> {
  const [privateKey, x25519PrivateKey] = await Promise.all([
    encrypt(toBuffer(input.edPrivateKey).toString('base64')),
    encrypt(toBuffer(input.x25519PrivateKey).toString('base64')),
  ]);
  return {
    nodeId: input.nodeId,
    hubUrl: input.hubUrl,
    privateKey,
    x25519PrivateKey,
    certificateJson: input.certificateJson,
    certSig: input.certSig,
    userId: input.userId ?? null,
  };
}

function persistEncryptedIdentity(db: AuthDb, identity: EncryptedIdentity): void {
  db.insert(nodeIdentity)
    .values({
      id: IDENTITY_ROW_ID,
      nodeId: identity.nodeId,
      hubUrl: identity.hubUrl,
      privateKey: identity.privateKey,
      x25519PrivateKey: identity.x25519PrivateKey,
      certificateJson: identity.certificateJson,
      certSig: toBuffer(identity.certSig),
      userId: identity.userId,
    })
    .onConflictDoUpdate({
      target: nodeIdentity.id,
      set: {
        nodeId: identity.nodeId,
        hubUrl: identity.hubUrl,
        privateKey: identity.privateKey,
        x25519PrivateKey: identity.x25519PrivateKey,
        certificateJson: identity.certificateJson,
        certSig: toBuffer(identity.certSig),
        userId: identity.userId,
      },
    })
    .run();
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
  record: ReturnType<typeof decodeKeyLogRecord>;
  bytes: Uint8Array;
  sig: Uint8Array;
  hash: Uint8Array;
  effects: KeyLogEffect[];
  now: number;
  nextHead: { seq: bigint; hash: Uint8Array };
  nextRootPublicKey: Uint8Array;
  nextRootEpoch: number;
  nextKdfParams: KdfParams;
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
    rootPublicKey: args.nextRootPublicKey,
    rootEpoch: args.nextRootEpoch,
    kdfParamsJson: kdfParamsToJson(args.nextKdfParams),
    now: args.now,
  });
  args.userStore.setKeyLogHead(args.userId, {
    seq: Number(args.nextHead.seq),
    hash: args.nextHead.hash,
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
    const payload = decodeAddPasskeyPayload(args.record.payload);
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
  } else if (args.record.type === 'remove-passkey') {
    const payload = decodeRemovePasskeyPayload(args.record.payload);
    const row = args.userStore.getKeyByCredentialId(decodeBase64url(payload.credential_id));
    if (row) {
      args.userStore.deleteKey(row.id);
    }
  }

  if (args.record.type === 'admit-node') {
    const payload = decodeAdmitNodePayload(args.record.payload);
    const certificate = decodeCertificate(payload.certificate_bytes);
    args.userStore.upsertCert({
      nodeId: nodeIdToHex(certificate.node_id),
      userId: args.userId,
      admitRecordSeq: seq,
      certificateBytes: payload.certificate_bytes,
      certSig: payload.cert_sig,
      authorizationBytes: payload.authorization_bytes,
      authorizationSig: payload.authorization_sig,
      revokedLogSeq: null,
    });
  } else if (args.record.type === 'revoke-node') {
    const payload = decodeRevokeNodePayload(args.record.payload);
    const hex = nodeIdToHex(payload.node_id);
    args.userStore.markCertRevoked(hex, seq);
    args.userStore.deletePeer(hex);
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
