import { LOGIN_CODE_CHALLENGE_PURPOSE } from '@vibeterm/shared';
import {
  type Delegation,
  decodeBase64url,
  decodeDelegation,
  decodeLogin,
  delegationChallenge,
  encodeBase64url,
  verifyDelegation,
  verifyDelegationTimes,
} from '@vibeterm/shared/auth';
import type { KeyLogEffect, VerifyDelegationPasskey } from '@vibeterm/shared/auth';
import { SET_SESSION_HEADER, setHeaderPair } from '@vibeterm/shared/http/mesh-headers';
import { readJsonObjectBody } from '../api/http';
import { requiredStrings } from '../api/route-input';
import type { ChallengeStore } from '../auth/challenge-store';
import { clearNavTicket, navTicketResponse } from '../auth/nav-ticket';
import { NODE_SESSION_TTL_MS, type NodeSessionStore } from '../auth/node-session-store';
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  decodePasskeyAssertionSig,
  makeVerifyDelegationPasskey,
  verifyRegistration,
} from '../auth/passkey';
import { popLoginAllowed } from '../auth/session-pop';
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
import {
  DELEGATION_BAD_SIGNATURE_FAIL,
  countActiveNodeSessions,
  delegationFailResult,
  logAuthLoginSuccessIfOk,
  logAuthLogout,
} from './auth-audit-log';
import {
  AuthKeyLogRoutes,
  bindLoginHooks,
  createLoginFailureSink,
  loginRequestContext,
  recordsOr405,
} from './auth-key-log-routes';
import { type LoginChainHost, runLoginChain } from './auth-login-chain';
import { type IssueSessionInput, LoginCodeRoutes } from './auth-login-code-routes';
import {
  LoginFailureLimiter,
  type LoginLimiterRejectInfo,
  type LoginMethod,
  LoginPolicyLimiter,
} from './auth-login-limiter';
import {
  attachLoginLimiter,
  currentLoginPolicy,
  handleLoginPolicyRequest,
  loginLimiterIp,
} from './auth-login-policy-http';
import {
  AuthModeCache,
  type AuthTlsInfoProvider,
  findPrimaryUser,
  isPasskeyAvailable,
  loadAuthModeTls,
  withAuthModeInvalidation,
} from './auth-mode-cache';
import {
  type PasskeyFactorResult,
  type TotpFactorResult,
  gatePasskeySecondFactor,
  sameCanonicalOrigin,
  verifySecondFactors,
} from './auth-passkey-origin';
import { defaultEntryOrigins } from './auth-passkey-origin-entry';
import { AUTH_LOGIN_PUBLIC_PATHS, isAuthLoginPublicPath } from './auth-public-paths';
import { TotpLoginGuard, verifyIssueTotp, verifyLoginTotp } from './auth-totp-guard';
import { handleTotpRecordRequest } from './auth-totp-record';
import { clientIpFromRequest, limiterIpKey } from './client-ip';
import { isPeerRequest, waivesPasskeySecondFactor } from './client-source';
import {
  AUTH_UID_MAX_BYTES,
  CHALLENGE_RATE_LIMIT,
  type KeyLogPublishAck,
  type KeyLogPublisher,
  LOGIN_CHALLENGE_TTL_MS,
  MESH_VIA_SELF,
  type MeshRoles,
  PASSKEY_REGISTER_TTL_MS,
  getMeshRequestContext,
  isStandaloneRoles,
} from './mesh-deps';
import {
  type SessionMiddlewareDeps,
  authenticateRequest,
  jsonBody,
  jsonError,
  publicRequestUrl,
  requireSession,
} from './session-middleware';
export type { KeyLogPublishAck };
export { AUTH_LOGIN_PUBLIC_PATHS, findPrimaryUser, isPasskeyAvailable };
export { createLoginFailureSink, verifySecondFactors };

export type AuthKeyLogPublisher = KeyLogPublisher;

export type AuthRateLimits = {
  consumeChallengeQuota(req: Request): Response | null;
  gateLogin(req: Request, uidHint: string, ip: string, method: LoginMethod): Response | null;
  recordLoginFailure(req: Request, uidHint: string, ip: string): void;
  recordLoginSuccess(ip: string): void;
};

const uidEncoder = new TextEncoder();

export function authUidTooLong(uid: string): boolean {
  return uidEncoder.encode(uid).byteLength > AUTH_UID_MAX_BYTES;
}

export function peekLoginUid(body: Record<string, unknown>): string {
  try {
    return typeof body.login === 'string' ? decodeLogin(decodeBase64url(body.login)).uid : '';
  } catch {
    return '';
  }
}
const IDENTIFIER_USERNAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{32}$/i;

export function authModeDisplayUsername(user: UserRecord | null): string | null {
  const username = user?.username ?? null;
  if (!username || username === user?.id || IDENTIFIER_USERNAME_RE.test(username)) return null;
  return username;
}
export type PublicAuthNode = { id: string; name: string; online: boolean };

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
  listPublicNodes?: () => PublicAuthNode[];
  onLogout?: (userId: string) => void;
  onKeyLogEffects?: (userId: string, effects: KeyLogEffect[]) => void;
  tlsInfo?: AuthTlsInfoProvider;
  localAuth?: LocalAuthStoreLike;
  onLimiterReject?: (info: LoginLimiterRejectInfo) => void;
};

export const AUTH_LOCAL_PRESESSION_PATHS = new Set([
  '/api/auth/local',
  '/api/auth/local/bootstrap',
]);

export function isAuthPublicPath(
  path: string,
  opts: { standalone: boolean; localAuthEffective: boolean; method?: string }
): boolean {
  if (isAuthLoginPublicPath(path, opts.method)) return true;
  return opts.standalone && !opts.localAuthEffective && AUTH_LOCAL_PRESESSION_PATHS.has(path);
}

export class AuthRoutes {
  private readonly policyLimiter = new LoginPolicyLimiter(
    () => this.now(),
    () => currentLoginPolicy(this.deps.userStore, this.deps.keyLogService, this.deps.primaryUserId)
  );
  private readonly challengeLimiter = new LoginFailureLimiter(() => this.now());
  private readonly loginLimits: ReturnType<typeof attachLoginLimiter>;
  private onLimiterReject: ((info: LoginLimiterRejectInfo) => void) | undefined;
  private readonly totpGuard = new TotpLoginGuard(() => this.now());
  private readonly sessionDeps: SessionMiddlewareDeps;
  private readonly verifyPasskey: VerifyDelegationPasskey;
  private tlsInfoProvider: AuthTlsInfoProvider | undefined;
  private localAuth: LocalAuthStoreLike;
  private readonly modeCache = new AuthModeCache();
  private readonly keyLog: AuthKeyLogRoutes;
  private readonly loginCodes: LoginCodeRoutes;
  readonly rateLimits: AuthRateLimits;

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
    this.onLimiterReject = bindLoginHooks(this.deps);
    this.loginLimits = attachLoginLimiter({
      limiter: this.policyLimiter,
      policy: () =>
        currentLoginPolicy(this.deps.userStore, this.deps.keyLogService, this.deps.primaryUserId),
      onReject: () => this.onLimiterReject,
      peekUid: peekLoginUid,
      uidTooLong: authUidTooLong,
      canonicalUid: (hint) => resolveUser(this.deps.userStore, hint)?.id ?? hint,
    });
    this.rateLimits = {
      consumeChallengeQuota: (req) => this.consumeChallengeQuota(req),
      gateLogin: (req, uidHint, ip, method) => this.loginLimits.gate(req, uidHint, ip, method),
      recordLoginFailure: (req, uidHint, ip) => this.loginLimits.record(req, uidHint, ip),
      recordLoginSuccess: (ip) => this.policyLimiter.recordSuccess(ip),
    };
    this.keyLog = new AuthKeyLogRoutes(deps, {
      invalidateAuthModeCache: () => this.invalidateAuthModeCache(),
    });
    this.loginCodes = new LoginCodeRoutes({
      userStore: deps.userStore,
      now: () => this.now(),
      openSink: (req, ctx) => this.loginLimits.openSink(req, ctx),
      issueChainHost: this.loginChainHost('issue'),
      consumeChallengeQuota: (req) => this.consumeChallengeQuota(req),
      recordLoginSuccess: (req) => this.policyLimiter.recordSuccess(loginLimiterIp(req)),
      issueSession: (input) => this.issueLoginSession(input),
      origin: requestOrigin,
    });
  }

  /** key log 撤销效果（任何应用路径）同步作废本节点待兑换的登录命令。 */
  applyKeyLogEffects(userId: string, effects: readonly KeyLogEffect[]): void {
    this.loginCodes.applyKeyLogEffects(userId, effects);
  }

  setTlsInfo(provider: AuthTlsInfoProvider | undefined): void {
    this.tlsInfoProvider = provider;
    this.invalidateAuthModeCache();
  }

  setLocalAuthStore(store: LocalAuthStoreLike): void {
    this.localAuth = store;
    this.invalidateAuthModeCache();
  }

  setOnLimiterReject(hook: ((info: LoginLimiterRejectInfo) => void) | undefined): void {
    this.onLimiterReject = hook;
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
      'GET /api/auth/nodes': () => this.handlePublicNodes(req),
      'POST /api/auth/challenge': () => this.handleChallenge(req),
      'POST /api/auth/login': () => this.handleLogin(req),
      'POST /api/auth/logout': () => session((r, uid) => this.handleLogout(r, uid)),
      'POST /api/auth/nav': () =>
        requireSession(this.sessionDeps, (_r, a) => navTicketResponse(this.deps, a.sid))(req),
      'POST /api/auth/passkey/register/options': () =>
        session((r, uid) => this.handlePasskeyRegisterOptions(r, uid)),
      'POST /api/auth/passkey/register/verify': () =>
        session((r, uid) => this.handlePasskeyRegisterVerify(r, uid)),
      'POST /api/auth/passkey/login/options': () => this.handlePasskeyLoginOptions(req),
      'GET /api/auth/keylog/head': () => session((_r, uid) => this.keyLog.handleKeyLogHead(uid)),
      'GET /api/auth/totp-record': () => handleTotpRecordRequest(session, this.deps),
      'GET /api/auth/login-policy': () =>
        session((_r, uid) => handleLoginPolicyRequest(uid, this.deps)),
      'GET /api/auth/passkeys': () => session((r, uid) => this.handlePasskeys(r, uid)),
      'POST /api/auth/keylog': () => session((r, uid) => this.keyLog.handleKeyLog(r, uid)),
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
    const loginCode = this.loginCodes.route(req, path);
    if (loginCode) return loginCode;
    if (path.startsWith('/api/auth/')) return recordsOr405(req, session);
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
    const fields = meshAuthModeUserFields(snapshot.user, origin, this.deps.userStore, {
      waivePasskeySecondFactor: waivesPasskeySecondFactor(req),
      totpSecretPresent: Boolean(
        snapshot.user && this.deps.keyLogService.currentState(snapshot.user.id).totp
      ),
    });
    const auth = authenticateRequest(req, this.sessionDeps);
    return jsonBody({
      ...shared,
      ...fields,
      username: authModeDisplayUsername(snapshot.user),
      rootPublicKey: auth.ok && auth.userId ? fields.rootPublicKey : null,
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

  private handlePublicNodes(req: Request): Response {
    const nodes = this.deps.listPublicNodes?.() ?? [
      { id: this.deps.nodeId, name: 'self', online: true },
    ];
    const auth = authenticateRequest(req, this.sessionDeps);
    if (auth.ok && auth.userId) return jsonBody({ nodes });
    return jsonBody({ nodes: [{ id: this.deps.nodeId }] });
  }

  private async handleChallenge(req: Request): Promise<Response> {
    const body = await readJsonObjectBody(req);
    const uidRaw = typeof body?.uid === 'string' ? body.uid : '';
    if (!uidRaw || authUidTooLong(uidRaw)) {
      return jsonError('MALFORMED', 400);
    }
    const purpose = body?.purpose;
    if (purpose !== undefined && purpose !== LOGIN_CODE_CHALLENGE_PURPOSE) {
      return jsonError('MALFORMED', 400);
    }
    const limited = this.consumeChallengeQuota(req);
    if (limited) return limited;
    const via = getMeshRequestContext(req).via || MESH_VIA_SELF;
    const created = this.deps.challengeStore.create({
      uid: uidRaw,
      entryNodeId: via,
      kind: purpose === LOGIN_CODE_CHALLENGE_PURPOSE ? 'login-code' : 'login',
      ttlMs: LOGIN_CHALLENGE_TTL_MS,
    });
    return jsonBody({
      challenge_id: created.challengeId,
      nonce: encodeBase64url(created.nonce),
      nodePk: encodeBase64url(this.deps.nodePk),
    });
  }

  private async handleLogin(req: Request): Promise<Response> {
    const ctx = loginRequestContext(req);
    const sink = this.loginLimits.openSink(req, ctx);
    const { fail, precheck } = sink;
    const body = await readJsonObjectBody(req);
    const blocked = precheck(body);
    if (blocked) return blocked;
    try {
      const rec = body as Record<string, unknown>;
      const chain = await runLoginChain(this.loginChainHost('login'), req, rec, sink, 'login');
      if (!chain.ok) return chain.res;
      const { challenge, envelope, user, now } = chain;
      const issued = this.issueLoginSession({
        userId: user.id,
        viaNodeId: challenge.entryNodeId,
        delegation: envelope.delegation,
        now,
        popRequired: popLoginAllowed(req, challenge.entryNodeId, rec.pop),
        fail,
      });
      logAuthLoginSuccessIfOk(issued, {
        uid: user.id,
        via: challenge.entryNodeId,
        method: envelope.delegation.method,
        totpBody: rec.totp,
        passkeyBody: rec.passkey,
        waived: waivesPasskeySecondFactor(req),
        ip: ctx.ip,
        origin: requestOrigin(req),
        req,
        afterOk: () => this.policyLimiter.recordSuccess(loginLimiterIp(req)),
      });
      return issued;
    } catch {
      return fail('MALFORMED', 400);
    }
  }

  /** `issue` 模式下 TOTP 走严格防重放（签发登录命令）。 */
  private loginChainHost(mode: 'login' | 'issue'): LoginChainHost {
    return {
      nodeId: this.deps.nodeId,
      nodePk: this.deps.nodePk,
      challengeStore: this.deps.challengeStore,
      now: () => this.now(),
      resolveUser: (uid) => resolveUser(this.deps.userStore, uid),
      verifyDelegation: (delegation, sig, user, now) =>
        this.verifyDelegationForLogin(delegation, sig, user, now),
      checkTotp: (user, method, totp, sessPk) => this.checkTotp(user, method, totp, sessPk, mode),
      checkPasskeySecondFactor: (r, u, delegation, passkey, totpVerified) =>
        this.checkPasskeySecondFactor(r, u, delegation, passkey, totpVerified),
    };
  }

  private handleLogout(_req: Request, userId: string | null): Response {
    if (userId) {
      const sessions = countActiveNodeSessions(this.deps.nodeSessionStore, userId);
      this.deps.nodeSessionStore.revokeAllForUser(userId, this.now());
      this.loginCodes.revokeForUser(userId);
      this.deps.onLogout?.(userId);
      logAuthLogout({ uid: userId, sessions });
    }
    const headers = new Headers({ 'content-type': 'application/json' });
    setHeaderPair(headers, SET_SESSION_HEADER, ';0');
    clearNavTicket(headers);
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
    if (authUidTooLong(fields.uid)) return jsonError('MALFORMED', 400);
    const limited = this.consumeChallengeQuota(req);
    if (limited) return limited;
    let delegation: Delegation;
    try {
      delegation = decodeDelegation(decodeBase64url(fields.delegation));
    } catch {
      return jsonError('MALFORMED', 400);
    }
    const origin = requestOrigin(req);
    const rpId = rpIdFromOrigin(origin);
    const user = resolveUser(this.deps.userStore, fields.uid);
    const keys = user
      ? this.deps.userStore
          .listKeysByUser(user.id)
          .filter((k) => sameCanonicalOrigin(k.origin, origin))
      : [];
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
      usableHere: sameCanonicalOrigin(k.origin, origin),
    }));
    return jsonBody({ passkeys });
  }

  private async verifyDelegationForLogin(
    delegation: Delegation,
    delegationSig: Uint8Array,
    user: UserRecord,
    now: number
  ): Promise<{ ok: true } | { ok: false; code: string; log: string }> {
    if (delegation.method === 'root') {
      const verified = verifyDelegation(delegation, delegationSig, {
        rootPublicKey: user.rootPublicKey,
        now,
      });
      return verified.ok ? { ok: true } : delegationFailResult(verified.error);
    }
    const times = verifyDelegationTimes(delegation, now);
    if (!times.ok) return delegationFailResult(times.error);
    const bad = DELEGATION_BAD_SIGNATURE_FAIL;
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

  private checkTotp(
    user: UserRecord,
    method: Delegation['method'],
    totpBody: unknown,
    sessPk: Uint8Array,
    mode: 'login' | 'issue' = 'login'
  ): Promise<TotpFactorResult> {
    return (mode === 'issue' ? verifyIssueTotp : verifyLoginTotp)({
      user,
      method,
      totpBody,
      sessPk,
      nowMs: this.now(),
      state: this.deps.keyLogService.currentState(user.id),
      guard: this.totpGuard,
    });
  }

  private async checkPasskeySecondFactor(
    req: Request,
    user: UserRecord,
    delegation: Delegation,
    passkeyBody: unknown,
    totpVerified: boolean
  ): Promise<PasskeyFactorResult> {
    if (delegation.method !== 'root') return { ok: true, assertionVerified: false };
    if (waivesPasskeySecondFactor(req)) return { ok: true, assertionVerified: false };
    const gate = gatePasskeySecondFactor({
      keys: this.deps.userStore.listKeysByUser(user.id),
      origin: requestOrigin(req),
      uid: user.id,
      body: passkeyBody,
      totpVerified,
      entryOrigins: defaultEntryOrigins(this.deps),
    });
    if (gate.kind === 'skip') return { ok: true, assertionVerified: false };
    if (gate.kind === 'reject') return { ok: false, code: gate.code, usableHere: gate.usableHere };
    try {
      const assertion = decodePasskeyAssertionSig(decodeBase64url(gate.sig));
      const ok = await this.verifyPasskey({
        challenge: delegationChallenge(delegation),
        delegation,
        assertion,
        credentialId: gate.credentialId,
      });
      return ok ? { ok: true, assertionVerified: true } : { ok: false, code: 'PASSKEY_INVALID' };
    } catch {
      return { ok: false, code: 'PASSKEY_INVALID' };
    }
  }

  private issueLoginSession(input: IssueSessionInput): Response {
    const { userId, viaNodeId, delegation, now, popRequired, fail, extra } = input;
    const base = { userId, viaNodeId, sessPublicKey: delegation.sess_pk, now, popRequired };
    const credentialId = credentialIdBytes(delegation.credential_id);
    if (delegation.method === 'passkey' && !credentialId?.byteLength) {
      return fail('DELEGATION_BAD_SIGNATURE');
    }
    const issued = this.deps.nodeSessionStore.issue(
      delegation.method === 'passkey' && credentialId
        ? { ...base, delegationMethod: 'passkey', credentialId }
        : { ...base, delegationMethod: 'root' }
    );
    const maxAgeSec = Math.max(0, Math.floor((issued.expiresAt - now) / 1000));
    const headers = new Headers({ 'content-type': 'application/json' });
    setHeaderPair(
      headers,
      SET_SESSION_HEADER,
      `${issued.sid};${maxAgeSec || Math.floor(NODE_SESSION_TTL_MS / 1000)}`
    );
    return jsonBody({ expires_at: issued.expiresAt, ...extra }, 200, headers);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private consumeChallengeQuota(req: Request): Response | null {
    if (isPeerRequest(req)) return null;
    const key = `ip:${limiterIpKey(clientIpFromRequest(req))}`;
    if (this.challengeLimiter.count(key) >= CHALLENGE_RATE_LIMIT) {
      return jsonError('RATE_LIMITED', 429);
    }
    this.challengeLimiter.record(key);
    return null;
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

function credentialIdBytes(id: string | null | undefined): Uint8Array | null {
  if (!id) return null;
  try {
    return decodeBase64url(id);
  } catch {
    return new TextEncoder().encode(id);
  }
}
