import {
  type Delegation,
  type Login,
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
import { HUB_NOT_WRITER, type HubMode } from '@tmex/shared/uplink';
import { readJsonObjectBody } from '../api/http';
import { requiredStrings } from '../api/route-input';
import type { ChallengeStore } from '../auth/challenge-store';
import { type MeshHubStore, pickWriterHub } from '../auth/mesh-hub-store';
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
import type { UserKeyRecord, UserRecord, UserStore } from '../auth/user-store';
import {
  handleLocalAuthBootstrap,
  handleLocalAuthToggle,
  isLocalAuthEffective,
  localAuthPayload,
  meshAuthModeUserFields,
} from '../db/local-auth-http';
import {
  LocalAuthStore,
  type LocalAuthStoreLike,
  standaloneClosedModeFields,
} from '../db/local-auth-settings';
import { filterNotRetiredHubRecords, inspectHubAuthRecordCompat } from '../hub/hub-authorization';
import { LoginFailureLimiter } from './auth-login-limiter';
import {
  AuthModeCache,
  findPrimaryUser,
  isPasskeyAvailable,
  loadAuthModeTls,
  withAuthModeInvalidation,
} from './auth-mode-cache';
import { clientIpFromRequest } from './client-ip';
import {
  type HubTlsInfoProvider,
  type KeyLogHubAck,
  type KeyLogPublisher,
  LOGIN_CHALLENGE_TTL_MS,
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
import { type AttachedHub, sameHubUrl } from './uplink-pool';

export type { KeyLogHubAck };
export { findPrimaryUser, isPasskeyAvailable };

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
  hubStore?: MeshHubStore;
  attachedHub?: () => AttachedHub | null;
  hubMode?: () => HubMode | null;
  listPublicNodes?: () => PublicAuthNode[];
  onLogout?: (userId: string) => void;
  onKeyLogEffects?: (userId: string, effects: KeyLogEffect[]) => void;
  tlsInfo?: HubTlsInfoProvider;
  localAuth?: LocalAuthStoreLike;
  forwardWriterWrite?: (req: Request, uid?: string) => Promise<Response | null>;
};

/** 与 node 相同的登录前公开面；role 无关。 */
export const AUTH_LOGIN_PUBLIC_PATHS = new Set([
  '/api/auth/mode',
  '/api/auth/nodes',
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/passkey/login/options',
]);

/** standalone 门未生效时允许无会话触达的本机登录开关。 */
export const AUTH_LOCAL_PRESESSION_PATHS = new Set([
  '/api/auth/local',
  '/api/auth/local/bootstrap',
]);

export function isAuthPublicPath(
  path: string,
  opts: { standalone: boolean; localAuthEffective: boolean }
): boolean {
  if (AUTH_LOGIN_PUBLIC_PATHS.has(path)) return true;
  if (opts.standalone && !opts.localAuthEffective && AUTH_LOCAL_PRESESSION_PATHS.has(path)) {
    return true;
  }
  return false;
}

export class AuthRoutes {
  private readonly limiter = new LoginFailureLimiter(() => this.now());
  private readonly sessionDeps: SessionMiddlewareDeps;
  private readonly verifyPasskey: VerifyDelegationPasskey;
  private tlsInfoProvider: HubTlsInfoProvider | undefined;
  private localAuth: LocalAuthStoreLike;
  private readonly modeCache = new AuthModeCache();
  private forwardWriterWrite: ((req: Request, uid?: string) => Promise<Response | null>) | null =
    null;

  constructor(private readonly deps: AuthRoutesDeps) {
    this.localAuth = deps.localAuth ?? new LocalAuthStore();
    this.sessionDeps = {
      roles: deps.roles,
      nodeSessionStore: deps.nodeSessionStore,
      now: deps.now,
      localAuthEffective: () => isLocalAuthEffective(this.localAuthCtx()),
    };
    this.verifyPasskey =
      deps.verifyDelegationPasskey ?? makeVerifyDelegationPasskey(deps.userStore);
    this.tlsInfoProvider = deps.tlsInfo;
    this.forwardWriterWrite = deps.forwardWriterWrite ?? null;
  }

  setWriterForward(fn: ((req: Request, uid?: string) => Promise<Response | null>) | null): void {
    this.forwardWriterWrite = fn;
  }

  setTlsInfo(provider: HubTlsInfoProvider | undefined): void {
    this.tlsInfoProvider = provider;
    this.invalidateAuthModeCache();
  }

  setLocalAuthStore(store: LocalAuthStoreLike): void {
    this.localAuth = store;
    this.invalidateAuthModeCache();
  }

  invalidateAuthModeCache(): void {
    this.modeCache.invalidate();
  }
  isLocalAuthEffective(): boolean {
    return isLocalAuthEffective(this.localAuthCtx());
  }

  async handle(req: Request): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    const session = (fn: (req: Request, uid: string | null) => Response | Promise<Response>) =>
      requireSession(this.sessionDeps, (r, auth) => fn(r, auth.userId))(req);
    const routes: Record<string, () => Response | Promise<Response>> = {
      'GET /api/auth/mode': () => this.handleMode(req),
      'GET /api/auth/nodes': () => this.handlePublicNodes(),
      'POST /api/auth/challenge': () => this.handleChallenge(req),
      'POST /api/auth/login': () => this.handleLogin(req),
      'POST /api/auth/logout': () => session((r, uid) => this.handleLogout(r, uid)),
      'POST /api/auth/passkey/register/options': () =>
        session((r, uid) => this.handlePasskeyRegisterOptions(r, uid)),
      'POST /api/auth/passkey/register/verify': () =>
        session((r, uid) => this.handlePasskeyRegisterVerify(r, uid)),
      'POST /api/auth/passkey/login/options': () => this.handlePasskeyLoginOptions(req),
      'GET /api/auth/keylog/head': () => session((_r, uid) => this.handleKeyLogHead(uid)),
      'GET /api/auth/passkeys': () => session((r, uid) => this.handlePasskeys(r, uid)),
      'POST /api/auth/keylog': () => session((r, uid) => this.handleKeyLog(r, uid)),
      'POST /api/auth/local': () =>
        withAuthModeInvalidation(this.modeCache, () =>
          handleLocalAuthToggle(req, this.localAuthCtx())
        ),
      'POST /api/auth/local/bootstrap': () =>
        withAuthModeInvalidation(this.modeCache, () =>
          handleLocalAuthBootstrap(req, this.localAuthCtx())
        ),
    };
    const run = routes[`${req.method} ${path}`];
    if (run) return run();
    if (path.startsWith('/api/auth/')) return jsonError('method_not_allowed', 405);
    return null;
  }

  private async handleMode(req: Request): Promise<Response> {
    const origin = requestOrigin(req);
    const snapshot = await this.modeCache.get(this.now(), async () => {
      const tls = await loadAuthModeTls(this.tlsInfoProvider);
      const localAuth = localAuthPayload(this.localAuthCtx());
      const closed = isStandaloneRoles(this.deps.roles) && !localAuth.effective;
      return {
        tls,
        localAuth,
        user: closed ? null : findPrimaryUser(this.deps.userStore, this.deps.primaryUserId),
        hub: closed ? { nodeId: null, publicUrl: null } : this.resolveHub(),
        closed,
      };
    });
    const shared = {
      nodeId: this.deps.nodeId,
      passkeyAvailable: isPasskeyAvailable(origin),
      caFingerprint: snapshot.tls.caFingerprint,
      localAuth: snapshot.localAuth,
    };
    if (snapshot.closed) {
      return jsonBody({ ...shared, ...standaloneClosedModeFields() });
    }
    return jsonBody({
      ...shared,
      ...meshAuthModeUserFields(snapshot.user, origin, this.deps.userStore, snapshot.hub),
    });
  }

  private localAuthCtx() {
    return {
      roles: this.deps.roles,
      userStore: this.deps.userStore,
      keyLogService: this.deps.keyLogService,
      localAuth: this.localAuth,
      sessionDeps: this.sessionDeps,
    };
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
    if (!user) return jsonError('UNKNOWN_USER', 404);
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
    const ip = clientIpFromRequest(req) ?? 'local';
    const body = await readJsonObjectBody(req);
    if (!body) {
      this.limiter.recordFailure(`ip:${ip}`);
      return jsonError('MALFORMED', 400);
    }
    let uidHint = peekLoginUid(body);
    if (this.limiter.isRateLimited(uidHint, ip)) return jsonError('RATE_LIMITED', 429);
    const fail = (code: string, status = 401): Response => {
      this.limiter.recordFailure(`ip:${ip}`);
      if (uidHint) this.limiter.recordFailure(`uid:${uidHint}`);
      return jsonError(code, status);
    };
    try {
      const envelope = parseLoginEnvelope(body);
      if (!envelope) return fail('MALFORMED', 400);
      uidHint = envelope.login.uid;
      if (this.limiter.isRateLimited(uidHint, ip)) return jsonError('RATE_LIMITED', 429);
      const challenge = this.deps.challengeStore.consume(envelope.login.challenge_id);
      if (!challenge || challenge.kind !== 'login') return fail('CHALLENGE_CONSUMED');
      const bound = loginBindingError(
        envelope.login,
        challenge,
        this.deps.nodeId,
        this.deps.nodePk,
        envelope.delegation.uid
      );
      if (bound) return fail(bound);
      const user = resolveUser(this.deps.userStore, envelope.login.uid);
      if (!user) return fail('UNKNOWN_USER', 404);
      const now = this.now();
      const delOk = await this.verifyDelegationForLogin(
        envelope.delegation,
        envelope.delegationSig,
        user,
        now
      );
      if (!delOk.ok) return fail(delOk.code);
      const loginOk = verifyLogin(envelope.login, envelope.sig, envelope.delegation.sess_pk, {
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        target: envelope.login.target,
        targetPk: this.deps.nodePk,
        uid: challenge.uid,
        entry: envelope.login.entry,
      });
      if (!loginOk.ok) return fail(loginErrorCode(loginOk.error));
      const totpCheck = await this.checkTotp(user, envelope.delegation.method, body.totp);
      if (!totpCheck.ok) return fail(totpCheck.code);
      return this.issueLoginSession(user.id, challenge.entryNodeId, envelope.delegation, now, fail);
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
    if (!userId) return jsonError('UNAUTHORIZED', 401);
    const user = this.deps.userStore.getById(userId);
    if (!user) return jsonError('UNKNOWN_USER', 404);
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
    if (!userId) return jsonError('UNAUTHORIZED', 401);
    const body = await readJsonObjectBody(req);
    if (!body || typeof body.response !== 'object' || body.response === null) {
      return jsonError('MALFORMED', 400);
    }
    const nested = body.response as { challenge_id?: unknown };
    const challengeId =
      [body.challenge_id, nested.challenge_id].find((v) => typeof v === 'string') ?? null;
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
    if (!verified) return jsonError('PASSKEY_VERIFY_FAILED', 400);
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
    const fields = body && requiredStrings(body, ['uid', 'delegation']);
    if (!fields) return jsonError('MALFORMED', 400);
    const user = resolveUser(this.deps.userStore, fields.uid);
    if (!user) return jsonError('UNKNOWN_USER', 404);
    let delegation: Delegation;
    try {
      delegation = decodeDelegation(decodeBase64url(fields.delegation));
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
    if (!userId) return jsonError('UNAUTHORIZED', 401);
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
    if (!userId) return jsonError('UNAUTHORIZED', 401);
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
    if (!userId) return jsonError('UNAUTHORIZED', 401);
    if (this.deps.roles.hub && this.deps.hubMode?.() === 'standby') {
      const forwarded = await this.forwardWriterWrite?.(req, userId);
      if (forwarded) return forwarded;
      return this.hubNotWriterResponse();
    }
    const body = await readJsonObjectBody(req);
    const fields = body && requiredStrings(body, ['bytes', 'sig']);
    if (!fields) return jsonError('MALFORMED', 400);
    let bytes: Uint8Array;
    let sig: Uint8Array;
    try {
      bytes = decodeBase64url(fields.bytes);
      sig = decodeBase64url(fields.sig);
    } catch {
      return jsonError('MALFORMED', 400);
    }
    const blocked = this.refuseIfAttachedNotWriter();
    if (blocked) return blocked;
    const compat = this.refuseUnsupportedHubAuthRecord(req, userId, bytes, sig);
    if (compat) return compat;
    const hubSync = this.usesHubSync(req);
    if (hubSync) {
      const force = req.headers.get('x-tmex-force-keylog') === '1';
      return this.handleKeyLogHubSync(userId, bytes, sig, force);
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
    sig: Uint8Array,
    force = false
  ): Promise<Response> {
    const preview = await this.previewKeyLog(userId, bytes, sig);
    if (!preview.ok) {
      if (preview.error === 'fork') {
        return jsonError('KEY_LOG_FORK', 409);
      }
      return jsonError(preview.error, 400);
    }
    const ack = await this.syncToHub({ bytes, sig, force });
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
    force?: boolean;
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
    force?: boolean;
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
    this.invalidateAuthModeCache();
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

  private refuseUnsupportedHubAuthRecord(
    req: Request,
    userId: string,
    bytes: Uint8Array,
    sig: Uint8Array
  ): Response | null {
    if (this.identicalAppliedRecord(userId, bytes, sig)) {
      return null;
    }
    const compat = inspectHubAuthRecordCompat(this.deps.userStore, bytes, userId);
    if (compat.ok) return null;
    const forced = req.headers.get('x-tmex-force-keylog') === '1';
    if (forced) {
      console.warn(
        `[auth] forcing key-log append despite ${compat.code} minVersion=${compat.minVersion} nodes=${compat.nodes
          .map((n) => n.id)
          .join(',')}`
      );
      return null;
    }
    return jsonError(compat.code, 409, {
      minVersion: compat.minVersion,
      nodes: compat.nodes,
    });
  }

  private authorizedHubRows() {
    return filterNotRetiredHubRecords(this.deps.hubStore?.list() ?? [], {
      userStore: this.deps.userStore,
      selfId: this.deps.nodeId,
    });
  }

  private refuseIfAttachedNotWriter(): Response | null {
    if (this.deps.roles.hub && this.deps.hubMode?.() === 'standby') {
      return this.hubNotWriterResponse();
    }
    const attached = this.deps.attachedHub?.();
    if (!attached) return null;
    const rows = this.authorizedHubRows();
    const writerId = pickWriterHub(rows);
    if (!writerId) return this.hubNotWriterResponse();
    const writer = this.deps.hubStore?.get(writerId);
    const attachedIsWriter =
      (attached.hubNodeId != null && attached.hubNodeId === writerId) ||
      Boolean(writer && sameHubUrl(attached.publicUrl, writer.publicUrl));
    if (attachedIsWriter) return null;
    return this.hubNotWriterResponse();
  }

  private hubNotWriterResponse(): Response {
    const rows = this.authorizedHubRows();
    const writerId = pickWriterHub(rows);
    const writer = writerId ? this.deps.hubStore?.get(writerId) : undefined;
    return jsonError(HUB_NOT_WRITER, 409, {
      writerHubId: writerId,
      writerPublicUrl: writer?.publicUrl ?? null,
      writerEpoch: writer?.writerEpoch ?? null,
    });
  }

  private resolveHub(): { nodeId: string | null; publicUrl: string | null } {
    const rows = this.authorizedHubRows();
    const writerId = pickWriterHub(rows);
    if (writerId) {
      const writer = this.deps.hubStore?.get(writerId);
      return {
        nodeId: writerId,
        publicUrl: writer?.publicUrl ?? this.deps.hubPublicUrl ?? null,
      };
    }
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
      return verified.ok ? { ok: true } : { ok: false, code: delegationErrorCode(verified.error) };
    }
    const times = verifyDelegationTimes(delegation, now);
    if (!times.ok) return { ok: false, code: delegationErrorCode(times.error) };
    const bad = { ok: false as const, code: 'DELEGATION_BAD_SIGNATURE' };
    if (!delegation.credential_id || delegation.uid !== user.id) return bad;
    let stored: UserKeyRecord | null;
    try {
      stored = this.deps.userStore.getKeyByCredentialId(decodeBase64url(delegation.credential_id));
    } catch {
      stored = null;
    }
    if (!stored || stored.userId !== user.id) return bad;
    let assertion: ReturnType<typeof decodePasskeyAssertionSig>;
    try {
      assertion = decodePasskeyAssertionSig(delegationSig);
    } catch {
      return bad;
    }
    const ok = await this.verifyPasskey({
      challenge: delegationChallenge(delegation),
      delegation,
      assertion,
      credentialId: delegation.credential_id,
    });
    return ok ? { ok: true } : bad;
  }

  private async checkTotp(
    user: UserRecord,
    method: Delegation['method'],
    totpBody: unknown
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    if (method !== 'root') return { ok: true };
    const state = this.deps.keyLogService.currentState(user.id);
    if (!state.totp || user.totpRecordSeq == null) return { ok: true };
    const parsed = parseTotpBody(totpBody);
    if (!parsed) return { ok: false, code: 'TOTP_REQUIRED' };
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

  private issueLoginSession(
    userId: string,
    viaNodeId: string,
    delegation: Delegation,
    now: number,
    fail: (code: string, status?: number) => Response
  ): Response {
    let issued: { sid: string; expiresAt: number };
    if (delegation.method === 'passkey') {
      const credentialId = credentialIdBytes(delegation.credential_id);
      if (!credentialId || credentialId.byteLength === 0) return fail('DELEGATION_BAD_SIGNATURE');
      issued = this.deps.nodeSessionStore.issue({
        userId,
        viaNodeId,
        sessPublicKey: delegation.sess_pk,
        delegationMethod: 'passkey',
        credentialId,
        now,
      });
    } else {
      issued = this.deps.nodeSessionStore.issue({
        userId,
        viaNodeId,
        sessPublicKey: delegation.sess_pk,
        delegationMethod: 'root',
        now,
      });
    }
    const maxAgeSec = Math.max(0, Math.floor((issued.expiresAt - now) / 1000));
    const headers = new Headers({
      'content-type': 'application/json',
      [X_TMEX_SET_SESSION]: `${issued.sid};${maxAgeSec || Math.floor(NODE_SESSION_TTL_MS / 1000)}`,
    });
    return jsonBody({ expires_at: issued.expiresAt }, 200, headers);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

export function resolveUser(store: UserStore, uid: string): UserRecord | null {
  return store.getById(uid) ?? store.getByUsername(uid);
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

function seqToJson(seq: bigint | number): number | string {
  const value = typeof seq === 'bigint' ? seq : BigInt(seq);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
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

function peekLoginUid(body: Record<string, unknown>): string {
  try {
    return typeof body.login === 'string' ? decodeLogin(decodeBase64url(body.login)).uid : '';
  } catch {
    return '';
  }
}

function parseLoginEnvelope(body: Record<string, unknown>) {
  const fields = requiredStrings(body, ['login', 'sig', 'delegation', 'delegation_sig']);
  if (!fields) return null;
  return {
    login: decodeLogin(decodeBase64url(fields.login)),
    sig: decodeBase64url(fields.sig),
    delegation: decodeDelegation(decodeBase64url(fields.delegation)),
    delegationSig: decodeBase64url(fields.delegation_sig),
  };
}

function loginBindingError(
  login: Login,
  challenge: { entryNodeId: string; uid: string },
  nodeId: string,
  nodePk: Uint8Array,
  delegationUid: string
): string | null {
  // 本机入口的 challenge 记录哨兵 'self'；浏览器按 /api/auth/mode.nodeId 填真实 id，CLI 填 'self'，两者都算本机
  const selfEntry = challenge.entryNodeId === MESH_VIA_SELF && login.entry === nodeId;
  if (login.entry !== challenge.entryNodeId && !selfEntry) return 'ENTRY_MISMATCH';
  if (login.target !== nodeId && login.target !== MESH_VIA_SELF) return 'TARGET_MISMATCH';
  if (!bytesEqual(login.target_pk, nodePk)) return 'TARGET_MISMATCH';
  if (login.uid !== delegationUid || login.uid !== challenge.uid) return 'UID_MISMATCH';
  return null;
}

function loginErrorCode(error: string): string {
  return (
    {
      challenge_mismatch: 'CHALLENGE_MISMATCH',
      target_mismatch: 'TARGET_MISMATCH',
      uid_mismatch: 'UID_MISMATCH',
      entry_mismatch: 'ENTRY_MISMATCH',
      bad_signature: 'BAD_SIGNATURE',
    }[error] ?? 'BAD_SIGNATURE'
  );
}

function delegationErrorCode(error: string): string {
  return (
    {
      expired: 'DELEGATION_EXPIRED',
      bad_signature: 'DELEGATION_BAD_SIGNATURE',
      method_mismatch: 'DELEGATION_METHOD_MISMATCH',
      invalid_ttl: 'DELEGATION_INVALID_TTL',
      issued_in_future: 'DELEGATION_ISSUED_IN_FUTURE',
    }[error] ?? 'DELEGATION_BAD_SIGNATURE'
  );
}
