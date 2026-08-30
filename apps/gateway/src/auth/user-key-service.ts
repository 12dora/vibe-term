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
  detectFork,
  emptyUserKeyState,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeKeyLogRecord,
  encodeResetRootPayload,
  generateKdfParams,
  genesisHead,
  hexToBytes,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
  verifyKeyLogRecord,
} from '@tmex/shared/auth';
import { encrypt } from '../crypto';
import { toBuffer } from './binary';
import type { KeyLogStore } from './key-log-store';
import { type NodeIdentityKeys, selfSignedNodeCertificate } from './node-identity-service';
import type { SaveNodeIdentityInput } from './node-identity-store';
import type { NodeSessionStore } from './node-session-store';
import type { AuthDb } from './types';
import {
  type AppliedKeyLogStep,
  type EncryptedIdentity,
  bindIdentityUser,
  createTxStores,
  kdfParamsToJson,
  persistApplied,
  persistEncryptedIdentity,
  wipeUserDerivedState,
} from './user-key-persistence';
import type { UserStore } from './user-store';

export { kdfParamsToJson };

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
  | { ok: true; state: UserKeyState; replacedStaleUsername?: string }
  | { ok: false; error: string };

type VerifyChainForJoinOptions = {
  anchorHash?: Uint8Array;
};

type CommitJoinInput = {
  records: ApplyKeyLogInput[];
  expectedRootPublicKey: Uint8Array;
  anchorHash: Uint8Array;
  username: string;
  expectedUserId: string;
  identity?: SaveNodeIdentityInput;
  now?: number;
};

type BootstrapSelfAdmitInput = {
  username: string;
  password: string;
  identity: NodeIdentityKeys;
  now?: number;
};

type DecodedKeyLog = ReturnType<typeof decodeKeyLogRecord>;

type JoinReplayStep = AppliedKeyLogStep;

type JoinReplaySuccess = {
  ok: true;
  genesisUid: string;
  state: UserKeyState;
  steps: JoinReplayStep[];
};

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
    if (!tryDecodeRecord(input.bytes)) {
      return { ok: false, error: 'malformed_payload' };
    }
    if (!this.userStore.getById(userId)) {
      return { ok: false, error: 'unknown_user' };
    }
    const stepped = await this.replayStep(input, this.currentState(userId), {
      allowGenesis: opts.allowGenesis,
      userId,
    });
    if (!stepped.ok) {
      return { ok: false, error: stepped.error as ApplyKeyLogFailure['error'] };
    }
    return this.commitVerified(userId, stepped);
  }

  private async commitVerified(
    userId: string,
    step: JoinReplayStep
  ): Promise<ApplyKeyLogServiceResult> {
    const now = Date.now();
    try {
      this.db.transaction((tx) => {
        const stores = createTxStores(tx, this.userStore, this.keyLogStore, this.nodeSessionStore);
        const again = stores.keyLogStore.getAtSeq(userId, Number(step.record.seq));
        if (
          again &&
          detectFork(
            { bytes: again.bytes, sig: again.sig },
            { bytes: step.input.bytes, sig: step.input.sig }
          )
        ) {
          throw new ForkCollision();
        }
        persistApplied(stores, userId, step, now);
      });
    } catch (err) {
      if (err instanceof ForkCollision) {
        return { ok: false, error: 'fork' };
      }
      throw err;
    }
    return {
      ok: true,
      seq: Number(step.record.seq),
      hash: step.hash,
      effects: step.effects,
    };
  }

  async applyMany(
    userId: string,
    records: ApplyKeyLogInput[],
    signal?: AbortSignal
  ): Promise<ApplyManyResult> {
    const abort = { ok: false as const, applied: 0 as const, error: 'aborted' };
    if (signal?.aborted) return abort;
    await Promise.resolve();
    if (signal?.aborted) return abort;

    const user = this.userStore.getById(userId);
    if (!user) return { ok: false, applied: 0, error: 'unknown_user' };
    if (records.length === 0) {
      return { ok: true, applied: 0, seq: user.keyLogHeadSeq, hash: user.keyLogHeadHash };
    }

    const prepared = await this.prepareApplyMany(userId, records, signal);
    if (!prepared.ok) return prepared;
    if (signal?.aborted) return abort;

    const { steps, casHead } = prepared;
    try {
      this.commitPrepared(userId, steps, casHead);
    } catch (err) {
      const mapped = mapApplyManyError(err);
      if (mapped) return mapped;
      throw err;
    }

    const last = steps.at(-1);
    if (!last) {
      return { ok: true, applied: 0, seq: Number(casHead.seq), hash: casHead.hash };
    }
    return {
      ok: true,
      applied: steps.length,
      seq: Number(last.next.head.seq),
      hash: last.next.head.hash,
    };
  }

  private commitPrepared(
    userId: string,
    steps: JoinReplayStep[],
    casHead: { seq: bigint; hash: Uint8Array }
  ): void {
    this.db.transaction((tx) => {
      const stores = createTxStores(tx, this.userStore, this.keyLogStore, this.nodeSessionStore);
      const current = stores.userStore.getById(userId);
      if (!current) throw new UnknownUser();
      if (
        BigInt(current.keyLogHeadSeq) !== casHead.seq ||
        !bytesEqual(current.keyLogHeadHash, casHead.hash)
      ) {
        throw new HeadCasMismatch();
      }
      const now = Date.now();
      for (const step of steps) persistApplied(stores, userId, step, now);
    });
  }

  private async prepareApplyMany(
    userId: string,
    records: ApplyKeyLogInput[],
    signal?: AbortSignal
  ): Promise<
    | { ok: true; steps: JoinReplayStep[]; casHead: { seq: bigint; hash: Uint8Array } }
    | { ok: false; applied: 0; error: string }
  > {
    const abort = { ok: false as const, applied: 0 as const, error: 'aborted' };
    const steps: JoinReplayStep[] = [];
    let state = this.currentState(userId);
    const casHead = { seq: state.head.seq, hash: state.head.hash };
    for (const input of records) {
      if (signal?.aborted) return abort;
      const stepped = await this.replayStep(input, state, { userId });
      if (!stepped.ok) return { ok: false, applied: 0, error: stepped.error };
      steps.push(stepped);
      state = stepped.next;
    }
    return { ok: true, steps, casHead };
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
    const genesisStep = await this.replayStep(genesisInput, state, { allowGenesis: true });
    if (!genesisStep.ok) {
      throw new Error(`bootstrap genesis apply failed: ${genesisStep.error}`);
    }
    state = genesisStep.next;

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
    const admitStep = await this.replayStep({ bytes: admitBytes, sig: admitSig }, state);
    if (!admitStep.ok) {
      throw new Error(`bootstrap admit-node apply failed: ${admitStep.error}`);
    }

    this.db.transaction((tx) => {
      const stores = createTxStores(tx, this.userStore, this.keyLogStore, this.nodeSessionStore);
      const { userStore, keyLogStore, nodeSessionStore } = stores;
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
      persistApplied(stores, userId, genesisStep, now);
      persistApplied(stores, userId, admitStep, now);
      bindIdentityUser(tx as AuthDb, userId);
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

  private async replayStep(
    input: ApplyKeyLogInput,
    state: UserKeyState,
    opts?: { allowGenesis?: boolean; userId?: string; rejectReset?: boolean }
  ): Promise<({ ok: true } & JoinReplayStep) | { ok: false; error: string }> {
    const record = tryDecodeRecord(input.bytes);
    if (!record) return { ok: false, error: 'malformed_payload' };
    if (opts?.rejectReset && record.type === 'reset-root') {
      return { ok: false, error: 'reset_not_genesis' };
    }
    const existing = opts?.userId
      ? this.keyLogStore.getAtSeq(opts.userId, Number(record.seq))
      : undefined;
    const verified = await verifyKeyLogRecord(input.bytes, input.sig, {
      head: state.head,
      rootEpoch: state.rootEpoch,
      rootPublicKey: state.rootPublicKey,
      resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
      verifyPasskeyAssertion: this.verifyPasskeyAssertion,
      existingAtSeq: existing ? { bytes: existing.bytes, sig: existing.sig } : undefined,
      allowGenesis: opts?.allowGenesis,
    });
    if (!verified.ok) return { ok: false, error: verified.error };
    const applied = await applyKeyLogRecord(state, verified.record, verified.hash, {
      verifyPasskeyAssertion: this.verifyPasskeyAssertion,
    });
    if (!applied.ok) return { ok: false, error: applied.error };
    return {
      ok: true,
      input,
      record: verified.record,
      hash: verified.hash,
      next: applied.state,
      effects: applied.effects,
    };
  }

  private async replayJoinChain(
    records: ApplyKeyLogInput[],
    expectedRootPublicKey: Uint8Array,
    anchorHash: Uint8Array
  ): Promise<JoinReplaySuccess | { ok: false; error: string }> {
    const first = records[0];
    if (!first) return { ok: false, error: 'missing_genesis' };
    const genesis = tryDecodeRecord(first.bytes);
    if (!genesis || genesis.type !== 'reset-root' || genesis.seq !== 1n) {
      return { ok: false, error: 'missing_genesis' };
    }

    let state = emptyUserKeyState(new Uint8Array(32), undefined, genesis.root_epoch);
    const steps: JoinReplayStep[] = [];
    let anchorFound = false;
    let epochAtAnchor: number | null = null;

    for (let i = 0; i < records.length; i++) {
      const item = records[i];
      if (!item) return { ok: false, error: 'malformed_payload' };
      const stepped = await this.replayStep(item, state, {
        allowGenesis: i === 0,
        rejectReset: i !== 0,
      });
      if (!stepped.ok) return stepped;
      if (bytesEqual(stepped.hash, anchorHash)) {
        anchorFound = true;
        epochAtAnchor = stepped.next.rootEpoch;
      } else if (
        anchorFound &&
        joinEpochBroke(stepped.record.type, stepped.next.rootEpoch, epochAtAnchor)
      ) {
        return { ok: false, error: 'epoch_changed' };
      }
      steps.push(stepped);
      state = stepped.next;
    }

    if (!anchorFound) return { ok: false, error: 'anchor_missing' };
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
    const { genesisUid, steps } = replay;
    const first = steps[0];
    if (!first) return { ok: false, error: 'missing_genesis' };
    let kdfJson = kdfParamsToJson(DEFAULT_KDF);
    try {
      kdfJson = kdfParamsToJson(decodeResetRootPayload(first.record.payload).kdf_params);
    } catch {
      kdfJson = kdfParamsToJson(DEFAULT_KDF);
    }

    let replacedStaleUsername: string | undefined;
    this.db.transaction((tx) => {
      const stores = createTxStores(tx, this.userStore, this.keyLogStore, this.nodeSessionStore);
      const { userStore, keyLogStore, nodeSessionStore } = stores;
      const byId = userStore.getById(genesisUid);
      const byName = userStore.getByUsername(username);
      if (byName && byName.id !== genesisUid) {
        wipeUserDerivedState(userStore, keyLogStore, nodeSessionStore, byName.id);
        userStore.deleteById(byName.id);
        userStore.deleteAllPeers();
        replacedStaleUsername = username;
      }
      if (byId) {
        wipeUserDerivedState(userStore, keyLogStore, nodeSessionStore, genesisUid);
        userStore.setKeyLogHead(genesisUid, { seq: 0, hash: ZERO_HASH, now });
        userStore.setTotpRecordSeq(genesisUid, null, now);
        userStore.updateRoot(genesisUid, {
          rootPublicKey: new Uint8Array(32),
          rootEpoch: first.record.root_epoch,
          kdfParamsJson: kdfJson,
          now,
        });
        if (byId.username !== username) userStore.updateUsername(genesisUid, username, now);
        if (!replacedStaleUsername) userStore.deleteAllPeers();
      } else {
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
      }
      for (const step of steps) persistApplied(stores, genesisUid, step, now);
      if (identity) persistEncryptedIdentity(tx as AuthDb, identity);
      else bindIdentityUser(tx as AuthDb, genesisUid);
    });
    return {
      ok: true,
      state: this.currentState(genesisUid),
      ...(replacedStaleUsername ? { replacedStaleUsername } : {}),
    };
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

function mapApplyManyError(err: unknown): ApplyManyResult | null {
  if (err instanceof ForkCollision) return { ok: false, applied: 0, error: 'fork' };
  if (err instanceof HeadCasMismatch) return { ok: false, applied: 0, error: 'head_cas' };
  if (err instanceof UnknownUser) return { ok: false, applied: 0, error: 'unknown_user' };
  return null;
}

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

function tryDecodeRecord(bytes: Uint8Array): DecodedKeyLog | null {
  try {
    return decodeKeyLogRecord(bytes);
  } catch {
    return null;
  }
}

function joinEpochBroke(
  type: DecodedKeyLog['type'],
  epoch: number,
  epochAtAnchor: number | null
): boolean {
  return (
    type === 'rotate-root' ||
    type === 'reset-root' ||
    (epochAtAnchor != null && epoch !== epochAtAnchor)
  );
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
