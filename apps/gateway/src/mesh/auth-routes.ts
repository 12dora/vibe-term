import {
  type Delegation,
  bytesEqual,
  decodeBase64url,
  decodeDelegation,
  decodeLogin,
  decryptTotpSecret,
  delegationChallenge,
  encodeBase64url,
  verifyDelegation,
  verifyDelegationTimes,
  verifyLogin,
  verifyTotpCode,
} from '@tmex/shared/auth';
import type { VerifyDelegationPasskey } from '@tmex/shared/auth';
import { readJsonObjectBody } from '../api/http';
import type { ChallengeStore } from '../auth/challenge-store';
import { buildClearCookie, buildSetCookie, nodeSessionCookieName } from '../auth/cookies';
import { NODE_SESSION_TTL_MS, type NodeSessionStore } from '../auth/node-session-store';
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  makeVerifyDelegationPasskey,
  verifyRegistration,
} from '../auth/passkey';
import type { UserKeyService } from '../auth/user-key-service';
import { kdfParamsFromJson } from '../auth/user-key-service';
import type { UserRecord, UserStore } from '../auth/user-store';
import {
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
  isHttps,
  jsonBody,
  jsonError,
  requireSession,
} from './session-middleware';

export type AuthRoutesDeps = {
  roles: MeshRoles;
  nodeId: string;
  nodePk: Uint8Array;
  userStore: UserStore;
  keyLogService: UserKeyService;
  challengeStore: ChallengeStore;
  nodeSessionStore: NodeSessionStore;
  publisher: KeyLogPublisher;
  now?: () => number;
  verifyDelegationPasskey?: VerifyDelegationPasskey;
  primaryUserId?: string;
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
      });
    }
    const user = findPrimaryUser(this.deps.userStore, this.deps.primaryUserId);
    const keys = user ? this.deps.userStore.listKeysByUser(user.id) : [];
    const passkeysForThisOrigin = keys.some((k) => k.origin === origin);
    const kdfParams = user ? publicKdfParams(user.kdfParamsJson) : null;
    return jsonBody({
      mode: 'mesh',
      nodeId: this.deps.nodeId,
      uid: user?.id ?? null,
      username: user?.username ?? null,
      kdfParams,
      passkeysForThisOrigin,
      passkeyAvailable: isPasskeyAvailable(origin),
      totpEnabled: user?.totpRecordSeq != null,
    });
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
      if (login.entry !== challenge.entryNodeId) {
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
      const via = getMeshRequestContext(req).via || MESH_VIA_SELF;
      if (via === MESH_VIA_SELF) {
        headers.append(
          'set-cookie',
          buildSetCookie(nodeSessionCookieName(MESH_VIA_SELF), issued.sid, {
            maxAgeSec: maxAgeSec || Math.floor(NODE_SESSION_TTL_MS / 1000),
            secure: isHttps(req),
          })
        );
      }
      return jsonBody({ sid: issued.sid, expires_at: issued.expiresAt }, 200, headers);
    } catch {
      return fail('MALFORMED', 400);
    }
  }

  private handleLogout(req: Request, userId: string | null): Response {
    if (!userId) {
      return jsonBody({ ok: true });
    }
    this.deps.nodeSessionStore.revokeAllForUser(userId, this.now());
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', buildClearCookie(nodeSessionCookieName(MESH_VIA_SELF)));
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
      rp_id: verified.rp_id,
      origin: verified.origin,
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
    const keys = this.deps.userStore.listKeysByUser(user.id);
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
    const applied = await this.deps.keyLogService.apply(userId, { bytes, sig });
    if (!applied.ok) {
      if (applied.error === 'fork') {
        return jsonError('KEY_LOG_FORK', 409);
      }
      return jsonError(applied.error, 400);
    }
    try {
      await this.deps.publisher.publish({ bytes, sig });
    } catch {
      // local apply is authoritative; hub fan-out is best-effort
    }
    return jsonBody({
      ok: true,
      seq: applied.seq,
      hash: encodeBase64url(applied.hash),
    });
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
    let assertion: unknown;
    try {
      assertion = JSON.parse(new TextDecoder().decode(delegationSig));
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
  return req.headers.get('origin') ?? new URL(req.url).origin;
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
