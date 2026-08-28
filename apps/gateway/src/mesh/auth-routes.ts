import {
  type Delegation,
  applyKeyLogRecord,
  bytesEqual,
  computeRecordHash,
  decodeBase64url,
  decodeDelegation,
  decodeKeyLogRecord,
  decodeLogin,
  decryptTotpSecret,
  delegationChallenge,
  encodeBase64url,
  verifyDelegation,
  verifyDelegationTimes,
  verifyKeyLogRecord,
  verifyLogin,
  verifyTotpCode,
} from '@tmex/shared/auth';
import type { KeyLogEffect, VerifyDelegationPasskey } from '@tmex/shared/auth';
import { readJsonObjectBody } from '../api/http';
import type { ChallengeStore } from '../auth/challenge-store';
import { NODE_SESSION_TTL_MS, type NodeSessionStore } from '../auth/node-session-store';
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  decodePasskeyAssertionSig,
  makeVerifyDelegationPasskey,
  makeVerifyPasskeyAssertion,
  verifyRegistration,
} from '../auth/passkey';
import type { UserKeyService } from '../auth/user-key-service';
import { kdfParamsFromJson } from '../auth/user-key-service';
import type { UserKeyRecord, UserRecord, UserStore } from '../auth/user-store';
import {
  type KeyLogHubAck,
  type KeyLogPublisher,
  LOGIN_CHALLENGE_TTL_MS,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_WINDOW_MS,
  MESH_VIA_SELF,
  type MeshRoles,
  PASSKEY_REGISTER_TTL_MS,
  X_TMEX_SET_SESSION,
  getMeshRequestContext,
  isStandaloneRoles,
} from './mesh-deps';
import {
  type SessionMiddlewareDeps,
  jsonBody,
  jsonError,
  publicRequestUrl,
  requireSession,
} from './session-middleware';

export type { KeyLogHubAck };

export type AuthKeyLogPublisher = KeyLogPublisher;

export type PublicAuthNode = {
  id: string;
  name: string;
  online: boolean;
};

export type AuthRoutesDeps = {
  roles: MeshRoles;
  nodeId: string;
  nodePk: Uint8Array;
  userStore: UserStore;
  keyLogService: UserKeyService;
  challengeStore: ChallengeStore;
  nodeSessionStore: NodeSessionStore;
  publisher: AuthKeyLogPublisher;
  now?: () => number;
  verifyDelegationPasskey?: VerifyDelegationPasskey;
  primaryUserId?: string;
  hubPublicUrl?: string | null;
  listPublicNodes?: () => PublicAuthNode[];
  onLogout?: (userId: string) => void;
  onKeyLogEffects?: (userId: string, effects: KeyLogEffect[]) => void;
};

export class AuthRoutes {
  private readonly failures = new Map<string, number[]>();
  private readonly sessionDeps: SessionMiddlewareDeps;
  private readonly verifyPasskey: VerifyDelegationPasskey;

  constructor(private readonly deps: AuthRoutesDeps) {
    this.sessionDeps = {
      roles: deps.roles,
      nodeSessionStore: deps.nodeSessionStore,
      now: deps.now,
    };
    this.verifyPasskey =
      deps.verifyDelegationPasskey ?? makeVerifyDelegationPasskey(deps.userStore);
  }

  async handle(req: Request): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    if (path === '/api/auth/mode' && req.method === 'GET') {
      return this.handleMode(req);
    }
    if (path === '/api/auth/nodes' && req.method === 'GET') {
      return this.handlePublicNodes();
    }
    if (path === '/api/auth/challenge' && req.method === 'POST') {
      return this.handleChallenge(req);
    }
    if (path === '/api/auth/login' && req.method === 'POST') {
      return this.handleLogin(req);
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      return requireSession(this.sessionDeps, (r, auth) => this.handleLogout(r, auth.userId))(req);
    }
    if (path === '/api/auth/passkey/register/options' && req.method === 'POST') {
      return requireSession(this.sessionDeps, (r, auth) =>
        this.handlePasskeyRegisterOptions(r, auth.userId)
      )(req);
    }
    if (path === '/api/auth/passkey/register/verify' && req.method === 'POST') {
      return requireSession(this.sessionDeps, (r, auth) =>
        this.handlePasskeyRegisterVerify(r, auth.userId)
      )(req);
    }
    if (path === '/api/auth/passkey/login/options' && req.method === 'POST') {
      return this.handlePasskeyLoginOptions(req);
    }
    if (path === '/api/auth/keylog/head' && req.method === 'GET') {
      return requireSession(this.sessionDeps, (_r, auth) => this.handleKeyLogHead(auth.userId))(
        req
      );
    }
    if (path === '/api/auth/passkeys' && req.method === 'GET') {
      return requireSession(this.sessionDeps, (r, auth) => this.handlePasskeys(r, auth.userId))(
        req
      );
    }
    if (path === '/api/auth/keylog' && req.method === 'POST') {
      return requireSession(this.sessionDeps, (r, auth) => this.handleKeyLog(r, auth.userId))(req);
    }
    if (path.startsWith('/api/auth/')) {
      return jsonError('method_not_allowed', 405);
    }
    return null;
  }

  private handleMode(req: Request): Response {
    const origin = requestOrigin(req);
    if (isStandaloneRoles(this.deps.roles)) {
      return jsonBody({
        mode: 'none',
        nodeId: this.deps.nodeId,
        uid: null,
        username: null,
        kdfParams: null,
        passkeysForThisOrigin: false,
        passkeyAvailable: isPasskeyAvailable(origin),
        totpEnabled: false,
        rootEpoch: null,
        rootPublicKey: null,
        hubNodeId: null,
        hubPublicUrl: null,
      });
    }
    const user = findPrimaryUser(this.deps.userStore, this.deps.primaryUserId);
    const keys = user ? this.deps.userStore.listKeysByUser(user.id) : [];
    const passkeysForThisOrigin = keys.some((k) => k.origin === origin);
    const kdfParams = user ? publicKdfParams(user.kdfParamsJson) : null;
    const hub = this.resolveHub();
    return jsonBody({
      mode: 'mesh',
      nodeId: this.deps.nodeId,
      uid: user?.id ?? null,
      username: user?.username ?? null,
      kdfParams,
      passkeysForThisOrigin,
      passkeyAvailable: isPasskeyAvailable(origin),
      totpEnabled: user?.totpRecordSeq != null,
      rootEpoch: user?.rootEpoch ?? null,
      rootPublicKey: user ? encodeBase64url(user.rootPublicKey) : null,
      hubNodeId: hub.nodeId,
      hubPublicUrl: hub.publicUrl,
    });
  }

  private handlePublicNodes(): Response {
    const nodes = this.deps.listPublicNodes?.() ?? [
      { id: this.deps.nodeId, name: 'self', online: true },
    ];
    return jsonBody({ nodes });
  }

  private async handleChallenge(req: Request): Promise<Response> {
    const body = await readJsonObjectBody(req);
    const uidRaw = typeof body?.uid === 'string' ? body.uid : '';
    if (!uidRaw) {
      return jsonError('MALFORMED', 400);
    }
    const user = resolveUser(this.deps.userStore, uidRaw);
    if (!user) {
      return jsonError('UNKNOWN_USER', 404);
    }
    const via = getMeshRequestContext(req).via || MESH_VIA_SELF;
    const created = this.deps.challengeStore.create({
      uid: user.id,
      entryNodeId: via,
      kind: 'login',
      ttlMs: LOGIN_CHALLENGE_TTL_MS,
    });
    return jsonBody({
      challenge_id: created.challengeId,
      nonce: encodeBase64url(created.nonce),
      nodePk: encodeBase64url(this.deps.nodePk),
    });
  }

  private async handleLogin(req: Request): Promise<Response> {
    const ip = getMeshRequestContext(req).clientIp ?? 'local';
    const body = await readJsonObjectBody(req);
    if (!body) {
      this.recordFailure(`ip:${ip}`);
      return jsonError('MALFORMED', 400);
    }

    let uidHint = '';
    try {
      if (typeof body.login === 'string') {
        uidHint = decodeLogin(decodeBase64url(body.login)).uid;
      }
    } catch {
      uidHint = '';
    }
    if (this.isRateLimited(uidHint, ip)) {
      return jsonError('RATE_LIMITED', 429);
    }

    const fail = (code: string, status = 401): Response => {
      this.recordFailure(`ip:${ip}`);
      if (uidHint) this.recordFailure(`uid:${uidHint}`);
      return jsonError(code, status);
    };

    try {
      if (
        typeof body.login !== 'string' ||
        typeof body.sig !== 'string' ||
        typeof body.delegation !== 'string' ||
        typeof body.delegation_sig !== 'string'
      ) {
        return fail('MALFORMED', 400);
      }
      const login = decodeLogin(decodeBase64url(body.login));
      const sig = decodeBase64url(body.sig);
      const delegation = decodeDelegation(decodeBase64url(body.delegation));
      const delegationSig = decodeBase64url(body.delegation_sig);
      uidHint = login.uid;

      if (this.isRateLimited(uidHint, ip)) {
        return jsonError('RATE_LIMITED', 429);
      }

      const challenge = this.deps.challengeStore.consume(login.challenge_id);
      if (!challenge || challenge.kind !== 'login') {
        return fail('CHALLENGE_CONSUMED');
      }
      // 本机入口的 challenge 记录哨兵 'self'；浏览器按 /api/auth/mode.nodeId 填真实 id，CLI 填 'self'，两者都算本机
      const entryIsSelf = challenge.entryNodeId === MESH_VIA_SELF;
      const entryMatches =
        login.entry === challenge.entryNodeId || (entryIsSelf && login.entry === this.deps.nodeId);
      if (!entryMatches) {
        return fail('ENTRY_MISMATCH');
      }
      if (login.target !== this.deps.nodeId && login.target !== MESH_VIA_SELF) {
        return fail('TARGET_MISMATCH');
      }
      if (!bytesEqual(login.target_pk, this.deps.nodePk)) {
        return fail('TARGET_MISMATCH');
      }
      if (login.uid !== delegation.uid || login.uid !== challenge.uid) {
        return fail('UID_MISMATCH');
      }

      const user = resolveUser(this.deps.userStore, login.uid);
      if (!user) {
        return fail('UNKNOWN_USER', 404);
      }

      const now = this.now();
      const delOk = await this.verifyDelegationForLogin(delegation, delegationSig, user, now);
      if (!delOk.ok) {
        return fail(delOk.code);
      }

      const loginOk = verifyLogin(login, sig, delegation.sess_pk, {
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        target: login.target,
        targetPk: this.deps.nodePk,
        uid: challenge.uid,
        entry: challenge.entryNodeId,
      });
      if (!loginOk.ok) {
        return fail(loginErrorCode(loginOk.error));
      }

      const totpBody = body.totp;
      const totpCheck = await this.checkTotp(user, delegation.method, totpBody);
      if (!totpCheck.ok) {
        return fail(totpCheck.code);
      }

      const issued =
        delegation.method === 'passkey'
          ? this.issuePasskeySession(user.id, challenge.entryNodeId, delegation, now)
          : this.deps.nodeSessionStore.issue({
              userId: user.id,
              viaNodeId: challenge.entryNodeId,
              sessPublicKey: delegation.sess_pk,
              delegationMethod: 'root',
              now,
            });
      if ('code' in issued) {
        return fail(issued.code);
      }
      const maxAgeSec = Math.max(0, Math.floor((issued.expiresAt - now) / 1000));
      const headers = new Headers({
        'content-type': 'application/json',
        [X_TMEX_SET_SESSION]: `${issued.sid};${maxAgeSec || Math.floor(NODE_SESSION_TTL_MS / 1000)}`,
      });
      return jsonBody({ expires_at: issued.expiresAt }, 200, headers);
    } catch {
      return fail('MALFORMED', 400);
    }
  }

  private handleLogout(_req: Request, userId: string | null): Response {
    if (userId) {
      this.deps.nodeSessionStore.revokeAllForUser(userId, this.now());
      this.deps.onLogout?.(userId);
    }
    const headers = new Headers({
      'content-type': 'application/json',
      [X_TMEX_SET_SESSION]: ';0',
    });
    return jsonBody({ ok: true }, 200, headers);
  }

  private async handlePasskeyRegisterOptions(
    req: Request,
    userId: string | null
  ): Promise<Response> {
    if (!userId) {
      return jsonError('UNAUTHORIZED', 401);
    }
    const user = this.deps.userStore.getById(userId);
    if (!user) {
      return jsonError('UNKNOWN_USER', 404);
    }
    const origin = requestOrigin(req);
    const rpId = rpIdFromOrigin(origin);
    const existing = this.deps.userStore
      .listKeysByUser(userId)
      .map((k) => encodeBase64url(k.credentialId));
    const created = this.deps.challengeStore.create({
      uid: userId,
      entryNodeId: getMeshRequestContext(req).via || MESH_VIA_SELF,
      kind: 'passkey-register',
      ttlMs: PASSKEY_REGISTER_TTL_MS,
      payload: { rpId, origin, userId },
    });
    const options = await createRegistrationOptions({
      uid: user.username,
      userId,
      rpId,
      existingCredentialIds: existing,
      challenge: created.nonce,
    });
    return jsonBody({ ...options, challenge_id: created.challengeId });
  }

  private async handlePasskeyRegisterVerify(
    req: Request,
    userId: string | null
  ): Promise<Response> {
    if (!userId) {
      return jsonError('UNAUTHORIZED', 401);
    }
    const body = await readJsonObjectBody(req);
    if (!body || typeof body.response !== 'object' || body.response === null) {
      return jsonError('MALFORMED', 400);
    }
    const challengeId =
      typeof body.challenge_id === 'string'
        ? body.challenge_id
        : typeof (body.response as { challenge_id?: string }).challenge_id === 'string'
          ? (body.response as { challenge_id: string }).challenge_id
          : null;
    const origin = requestOrigin(req);
    const rpId = rpIdFromOrigin(origin);
    const entry = challengeId ? this.deps.challengeStore.consume(challengeId) : null;
    if (!entry || entry.kind !== 'passkey-register' || entry.uid !== userId) {
      return jsonError('CHALLENGE_CONSUMED', 401);
    }
    const payload = (entry.payload ?? {}) as { rpId?: string; origin?: string };
    const expectedChallenge = encodeBase64url(entry.nonce);
    const verified = await verifyRegistration({
      response: body.response as Parameters<typeof verifyRegistration>[0]['response'],
      expectedChallenge,
      origin: payload.origin ?? origin,
      rpId: payload.rpId ?? rpId,
    });
    if (!verified) {
      return jsonError('PASSKEY_VERIFY_FAILED', 400);
    }
    return jsonBody({
      credential_id: verified.credential_id,
      public_key: encodeBase64url(verified.public_key),
      rp_id: payload.rpId ?? verified.rp_id,
      origin: payload.origin ?? verified.origin,
      counter: verified.counter,
      transports: verified.transports,
      backup_eligible: verified.backup_eligible,
      backup_state: verified.backup_state,
      device_type: verified.device_type,
      name: verified.name,
    });
  }

  private async handlePasskeyLoginOptions(req: Request): Promise<Response> {
    const body = await readJsonObjectBody(req);
    if (!body || typeof body.uid !== 'string' || typeof body.delegation !== 'string') {
      return jsonError('MALFORMED', 400);
    }
    const user = resolveUser(this.deps.userStore, body.uid);
    if (!user) {
      return jsonError('UNKNOWN_USER', 404);
    }
    let delegation: Delegation;
    try {
      delegation = decodeDelegation(decodeBase64url(body.delegation));
    } catch {
      return jsonError('MALFORMED', 400);
    }
    const origin = requestOrigin(req);
    const rpId = rpIdFromOrigin(origin);
    const keys = this.deps.userStore.listKeysByUser(user.id).filter((k) => k.origin === origin);
    if (keys.length === 0) {
      return jsonError('NO_PASSKEY_FOR_ORIGIN', 404);
    }
    const options = await createAuthenticationOptions({
      rpId,
      allowCredentials: keys.map((k) => ({
        id: encodeBase64url(k.credentialId),
        transports: k.transports as never,
      })),
      challenge: delegationChallenge(delegation),
    });
    return jsonBody(options);
  }

  private handleKeyLogHead(userId: string | null): Response {
    if (!userId) {
      return jsonError('UNAUTHORIZED', 401);
    }
    try {
      const state = this.deps.keyLogService.currentState(userId);
      return jsonBody({
        seq: seqToJson(state.head.seq),
        hash: encodeBase64url(state.head.hash),
        rootEpoch: state.rootEpoch,
        uid: userId,
      });
    } catch {
      return jsonError('UNKNOWN_USER', 404);
    }
  }

  private handlePasskeys(req: Request, userId: string | null): Response {
    if (!userId) {
      return jsonError('UNAUTHORIZED', 401);
    }
    const origin = requestOrigin(req);
    const passkeys = this.deps.userStore.listKeysByUser(userId).map((k) => ({
      credential_id: encodeBase64url(k.credentialId),
      name: k.name,
      rp_id: k.rpId,
      origin: k.origin,
      created_at: k.createdAt,
      log_seq: k.logSeq,
      usableHere: k.origin === origin,
    }));
    return jsonBody({ passkeys });
  }

  private async handleKeyLog(req: Request, userId: string | null): Promise<Response> {
    if (!userId) {
      return jsonError('UNAUTHORIZED', 401);
    }
    const body = await readJsonObjectBody(req);
    if (!body || typeof body.bytes !== 'string' || typeof body.sig !== 'string') {
      return jsonError('MALFORMED', 400);
    }
    let bytes: Uint8Array;
    let sig: Uint8Array;
    try {
      bytes = decodeBase64url(body.bytes);
      sig = decodeBase64url(body.sig);
    } catch {
      return jsonError('MALFORMED', 400);
    }
    const hubSync = this.usesHubSync(req);
    if (hubSync) {
      return this.handleKeyLogHubSync(userId, bytes, sig);
    }
    const applied = await this.deps.keyLogService.apply(userId, { bytes, sig });
    if (!applied.ok) {
      const replayed = this.identicalAppliedRecord(userId, bytes, sig);
      if (replayed) {
        this.deps.onKeyLogEffects?.(userId, []);
        return this.keyLogSuccess(replayed.seq, replayed.hash, false);
      }
      if (applied.error === 'fork') {
        return jsonError('KEY_LOG_FORK', 409);
      }
      return jsonError(applied.error, 400);
    }
    this.deps.onKeyLogEffects?.(userId, applied.effects);
    try {
      await this.deps.publisher.publish({ bytes, sig });
    } catch {
      // local apply is authoritative; hub fan-out is best-effort
    }
    return this.keyLogSuccess(applied.seq, applied.hash, false);
  }

  private usesHubSync(req: Request): boolean {
    if (new URL(req.url).searchParams.get('hub') === 'sync') return true;
    return Boolean(this.deps.roles.node) && !this.deps.roles.hub;
  }

  private async handleKeyLogHubSync(
    userId: string,
    bytes: Uint8Array,
    sig: Uint8Array
  ): Promise<Response> {
    const preview = await this.previewKeyLog(userId, bytes, sig);
    if (!preview.ok) {
      if (preview.error === 'fork') {
        return jsonError('KEY_LOG_FORK', 409);
      }
      return jsonError(preview.error, 400);
    }
    const ack = await this.syncToHub({ bytes, sig });
    if (!ack.ok) {
      if (ack.error === 'HUB_TIMEOUT') {
        return jsonError('HUB_TIMEOUT', 504);
      }
      return jsonError(ack.error, 409);
    }
    const applied = await this.deps.keyLogService.apply(userId, { bytes, sig });
    if (!applied.ok) {
      const replayed = this.identicalAppliedRecord(userId, bytes, sig);
      if (replayed) {
        this.deps.onKeyLogEffects?.(userId, []);
        return this.keyLogSuccess(replayed.seq, replayed.hash, true, true);
      }
      if (applied.error === 'fork') {
        return jsonError('KEY_LOG_FORK', 409);
      }
      return jsonError(applied.error, 400);
    }
    this.deps.onKeyLogEffects?.(userId, applied.effects);
    return this.keyLogSuccess(applied.seq, applied.hash, true, true);
  }

  private async previewKeyLog(
    userId: string,
    bytes: Uint8Array,
    sig: Uint8Array
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.identicalAppliedRecord(userId, bytes, sig)) {
      return { ok: true };
    }
    try {
      const state = this.deps.keyLogService.currentState(userId);
      const verifyPasskeyAssertion = makeVerifyPasskeyAssertion(this.deps.userStore);
      const verified = await verifyKeyLogRecord(bytes, sig, {
        head: state.head,
        rootEpoch: state.rootEpoch,
        rootPublicKey: state.rootPublicKey,
        resolvePasskey: (id) => state.passkeys.get(id)?.public_key ?? null,
        verifyPasskeyAssertion,
      });
      if (!verified.ok) {
        return verified;
      }
      const applied = await applyKeyLogRecord(state, verified.record, verified.hash, {
        verifyPasskeyAssertion,
      });
      if (!applied.ok) {
        return { ok: false, error: applied.error };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'malformed_payload' };
    }
  }

  private async syncToHub(record: {
    bytes: Uint8Array;
    sig: Uint8Array;
  }): Promise<KeyLogHubAck> {
    if (!this.deps.publisher.publishAndAck) {
      return { ok: false, error: 'unavailable' };
    }
    const first = await this.safePublishAndAck(record);
    if (first.ok) return first;
    if (first.error !== 'timeout') return first;
    const retry = await this.safePublishAndAck(record);
    if (retry.ok) return retry;
    if (retry.error !== 'timeout') return retry;
    if (await this.hubAlreadyHasRecord(record)) {
      let seq: bigint | number = 0;
      try {
        seq = decodeKeyLogRecord(record.bytes).seq;
      } catch {
        seq = 0;
      }
      return { ok: true, seq };
    }
    return { ok: false, error: 'HUB_TIMEOUT' };
  }

  private async safePublishAndAck(record: {
    bytes: Uint8Array;
    sig: Uint8Array;
  }): Promise<KeyLogHubAck> {
    const publishAndAck = this.deps.publisher.publishAndAck;
    if (!publishAndAck) {
      return { ok: false, error: 'unavailable' };
    }
    try {
      return await publishAndAck(record);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'hub_error';
      return { ok: false, error: message === 'timeout' ? 'timeout' : message };
    }
  }

  private async hubAlreadyHasRecord(record: {
    bytes: Uint8Array;
    sig: Uint8Array;
  }): Promise<boolean> {
    try {
      const seq = decodeKeyLogRecord(record.bytes).seq;
      const remote = await this.deps.publisher.queryKeyLogAt?.(seq);
      if (remote && bytesEqual(remote.bytes, record.bytes) && bytesEqual(remote.sig, record.sig)) {
        return true;
      }
    } catch {
      // fall through to head hash
    }
    const head = await this.deps.publisher.queryHubHead?.();
    if (!head) return false;
    return bytesEqual(head.hash, computeRecordHash(record.bytes, record.sig));
  }

  private identicalAppliedRecord(
    userId: string,
    bytes: Uint8Array,
    sig: Uint8Array
  ): { seq: number; hash: Uint8Array } | null {
    try {
      const record = decodeKeyLogRecord(bytes);
      const state = this.deps.keyLogService.currentState(userId);
      const hash = computeRecordHash(bytes, sig);
      if (state.head.seq === record.seq && bytesEqual(state.head.hash, hash)) {
        return { seq: Number(record.seq), hash };
      }
    } catch {
      return null;
    }
    return null;
  }

  private keyLogSuccess(
    seq: number | bigint,
    hash: Uint8Array,
    hubSync: boolean,
    hubAck?: boolean,
    hubError?: string
  ): Response {
    if (!hubSync) {
      return jsonBody({
        ok: true,
        seq,
        hash: encodeBase64url(hash),
      });
    }
    return jsonBody({
      ok: true,
      seq,
      hash: encodeBase64url(hash),
      hubAck: hubAck === true,
      ...(hubError ? { hubError } : {}),
    });
  }

  private resolveHub(): { nodeId: string | null; publicUrl: string | null } {
    const meta = this.deps.userStore.getHubMeta();
    if (this.deps.roles.hub) {
      return {
        nodeId: this.deps.nodeId,
        publicUrl: this.deps.hubPublicUrl ?? meta?.publicUrl ?? null,
      };
    }
    return {
      nodeId: meta?.nodeId ?? null,
      publicUrl: meta?.publicUrl ?? this.deps.hubPublicUrl ?? null,
    };
  }

  private async verifyDelegationForLogin(
    delegation: Delegation,
    delegationSig: Uint8Array,
    user: UserRecord,
    now: number
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    if (delegation.method === 'root') {
      const verified = verifyDelegation(delegation, delegationSig, {
        rootPublicKey: user.rootPublicKey,
        now,
      });
      if (!verified.ok) {
        return { ok: false, code: delegationErrorCode(verified.error) };
      }
      return { ok: true };
    }
    const times = verifyDelegationTimes(delegation, now);
    if (!times.ok) {
      return { ok: false, code: delegationErrorCode(times.error) };
    }
    if (!delegation.credential_id) {
      return { ok: false, code: 'DELEGATION_BAD_SIGNATURE' };
    }
    if (delegation.uid !== user.id) {
      return { ok: false, code: 'DELEGATION_BAD_SIGNATURE' };
    }
    let stored: UserKeyRecord | null;
    try {
      stored = this.deps.userStore.getKeyByCredentialId(decodeBase64url(delegation.credential_id));
    } catch {
      stored = null;
    }
    if (!stored || stored.userId !== user.id) {
      return { ok: false, code: 'DELEGATION_BAD_SIGNATURE' };
    }
    let assertion: ReturnType<typeof decodePasskeyAssertionSig>;
    try {
      assertion = decodePasskeyAssertionSig(delegationSig);
    } catch {
      return { ok: false, code: 'DELEGATION_BAD_SIGNATURE' };
    }
    const ok = await this.verifyPasskey({
      challenge: delegationChallenge(delegation),
      delegation,
      assertion,
      credentialId: delegation.credential_id,
    });
    if (!ok) {
      return { ok: false, code: 'DELEGATION_BAD_SIGNATURE' };
    }
    return { ok: true };
  }

  private async checkTotp(
    user: UserRecord,
    method: Delegation['method'],
    totpBody: unknown
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    if (method !== 'root') {
      return { ok: true };
    }
    const state = this.deps.keyLogService.currentState(user.id);
    if (!state.totp || user.totpRecordSeq == null) {
      return { ok: true };
    }
    const parsed = parseTotpBody(totpBody);
    if (!parsed) {
      return { ok: false, code: 'TOTP_REQUIRED' };
    }
    try {
      const secret = await decryptTotpSecret(parsed.kTotp, state.totp, {
        uid: user.id,
        root_epoch: state.rootEpoch,
        seq: BigInt(user.totpRecordSeq),
      });
      const timeSec = Math.floor(this.now() / 1000);
      if (!verifyTotpCode(secret, parsed.code, timeSec)) {
        return { ok: false, code: 'TOTP_INVALID' };
      }
      return { ok: true };
    } catch {
      return { ok: false, code: 'TOTP_INVALID' };
    }
  }

  private issuePasskeySession(
    userId: string,
    viaNodeId: string,
    delegation: Delegation,
    now: number
  ): { sid: string; expiresAt: number; hardExpiresAt: number } | { code: string } {
    const credentialId = credentialIdBytes(delegation.credential_id);
    if (!credentialId || credentialId.byteLength === 0) {
      return { code: 'DELEGATION_BAD_SIGNATURE' };
    }
    return this.deps.nodeSessionStore.issue({
      userId,
      viaNodeId,
      sessPublicKey: delegation.sess_pk,
      delegationMethod: 'passkey',
      credentialId,
      now,
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private isRateLimited(uid: string, ip: string): boolean {
    const t = this.now();
    const uidOver = uid ? this.countFailures(`uid:${uid}`, t) >= LOGIN_RATE_LIMIT : false;
    const ipOver = this.countFailures(`ip:${ip}`, t) >= LOGIN_RATE_LIMIT;
    return uidOver || ipOver;
  }

  private recordFailure(key: string): void {
    const t = this.now();
    const next = this.prune(this.failures.get(key) ?? [], t);
    next.push(t);
    this.failures.set(key, next);
  }

  private countFailures(key: string, now: number): number {
    const next = this.prune(this.failures.get(key) ?? [], now);
    this.failures.set(key, next);
    return next.length;
  }

  private prune(times: number[], now: number): number[] {
    return times.filter((t) => now - t < LOGIN_RATE_WINDOW_MS);
  }
}

export function resolveUser(store: UserStore, uid: string): UserRecord | null {
  return store.getById(uid) ?? store.getByUsername(uid);
}

export function findPrimaryUser(store: UserStore, primaryUserId?: string): UserRecord | null {
  if (primaryUserId) {
    const direct = store.getById(primaryUserId) ?? store.getByUsername(primaryUserId);
    if (direct) return direct;
  }
  for (const cert of store.listCerts()) {
    const user = store.getById(cert.userId);
    if (user) return user;
  }
  for (const node of store.listNodes()) {
    const user = store.getById(node.userId);
    if (user) return user;
  }
  return null;
}

export function requestOrigin(req: Request): string {
  return req.headers.get('origin') ?? publicRequestUrl(req).origin;
}

export function rpIdFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return 'localhost';
  }
}

export function isPasskeyAvailable(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    const secure = url.protocol === 'https:' || host === 'localhost' || host.endsWith('.localhost');
    const ip = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
    const domainOrLocalhost = host === 'localhost' || host.endsWith('.localhost') || !ip;
    return secure && domainOrLocalhost;
  } catch {
    return false;
  }
}

function seqToJson(seq: bigint | number): number | string {
  const value = typeof seq === 'bigint' ? seq : BigInt(seq);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function publicKdfParams(jsonStr: string): {
  salt: string;
  memory_kib: number;
  iterations: number;
  parallelism: number;
} {
  const params = kdfParamsFromJson(jsonStr);
  return {
    salt: encodeBase64url(params.salt),
    memory_kib: params.memory_kib,
    iterations: params.iterations,
    parallelism: params.parallelism,
  };
}

function credentialIdBytes(id: string | null): Uint8Array | null {
  if (!id) return null;
  try {
    return decodeBase64url(id);
  } catch {
    return new TextEncoder().encode(id);
  }
}

function parseTotpBody(value: unknown): { code: string; kTotp: Uint8Array } | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as { code?: unknown; k_totp?: unknown };
  if (typeof rec.code !== 'string' || typeof rec.k_totp !== 'string') return null;
  try {
    return { code: rec.code, kTotp: decodeBase64url(rec.k_totp) };
  } catch {
    return null;
  }
}

function loginErrorCode(error: string): string {
  switch (error) {
    case 'challenge_mismatch':
      return 'CHALLENGE_MISMATCH';
    case 'target_mismatch':
      return 'TARGET_MISMATCH';
    case 'uid_mismatch':
      return 'UID_MISMATCH';
    case 'entry_mismatch':
      return 'ENTRY_MISMATCH';
    case 'bad_signature':
      return 'BAD_SIGNATURE';
    default:
      return 'BAD_SIGNATURE';
  }
}

function delegationErrorCode(error: string): string {
  switch (error) {
    case 'expired':
      return 'DELEGATION_EXPIRED';
    case 'bad_signature':
      return 'DELEGATION_BAD_SIGNATURE';
    case 'method_mismatch':
      return 'DELEGATION_METHOD_MISMATCH';
    case 'invalid_ttl':
      return 'DELEGATION_INVALID_TTL';
    case 'issued_in_future':
      return 'DELEGATION_ISSUED_IN_FUTURE';
    default:
      return 'DELEGATION_BAD_SIGNATURE';
  }
}
