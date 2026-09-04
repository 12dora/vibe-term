import {
  bytesEqual,
  decodeAuthorization,
  decodeBase64url,
  encodeBase64url,
  hubHostFromUrl,
  sha256,
  verifyEd25519,
} from '@tmex/shared/auth';
import {
  RELAY_ENROLL_PROOF_MAX_SKEW_MS,
  generateTenantKey,
  verifyRelayEnrollProof,
} from '@tmex/shared/relay';
import { readJsonObjectBody } from '../api/http';
import type { UserKeyService } from '../auth';
import { makeVerifyPasskeyAssertion } from '../auth/passkey';
import type { UserStore } from '../auth/user-store';
import { isTrustedLocalClient } from './client-source';
import { type RelayDialContext, relayDialContextFromEnv, resolveRelayDialUrl } from './relay-dial';
import {
  RELAY_ENROLLMENT_FANOUT_TIMEOUT_MS,
  collectJoinMaterialRelays,
  fanOutEnrollmentCreate,
} from './relay-enrollment-fanout';
import { handleMeshRelayPack } from './relay-pack-routes';
import {
  buildMetaKeyPayload,
  buildSetRelaysPayload,
  listRelayNodeKeys,
  mergeRelayTargets,
  nextRelayPriority,
  relayPayloadHash,
} from './relay-payloads';
import { buildReadmitPrepare } from './relay-readmit';
import {
  type ParsedEnrollment,
  normalizeUrlOrNull,
  parseEnrollmentBody,
  parseStoredJson,
  readProof,
  readRelayErrorCode,
} from './relay-routes-input';
import type { RelaySecrets } from './relay-secrets';
import { buildRelayStatusRow } from './relay-status-row';
import { handleRelaySwitch } from './relay-switch-route';
import type { RelayUplinkView } from './relay-switch-route';
import { RelayUplinkClient } from './relay-uplink-client';
import {
  type SessionMiddlewareDeps,
  jsonBody,
  jsonError,
  requireSession,
} from './session-middleware';

export { RELAY_SWITCH_TIMEOUT_MS, type RelayUplinkView } from './relay-switch-route';

export const RELAY_ROUTE_PREFIX = '/api/mesh/relay';
export const RELAY_ENROLL_FETCH_TIMEOUT_MS = 15_000;
export const RELAY_ENROLLMENT_ACK_TIMEOUT_MS = 10_000;

export type RelayRoutesDeps = {
  session: SessionMiddlewareDeps;
  nodeId: string;
  userStore: UserStore;
  keyLogService: UserKeyService;
  secrets: RelaySecrets;
  uplink: RelayUplinkView;
  fetchImpl?: typeof fetch;
  now?: () => number;
  dial?: RelayDialContext;
  enrollmentFanoutTimeoutMs?: number;
  switchTimeoutMs?: number;
};

type PreparedPayload = { payload: string; payloadHash: string };
type RelayRouteHandler = (req: Request, userId: string) => Promise<Response> | Response;

export function isLocalRelayStatusRequest(req: Request, path = new URL(req.url).pathname): boolean {
  return (
    req.method === 'GET' && path === `${RELAY_ROUTE_PREFIX}/status` && isTrustedLocalClient(req)
  );
}

/** 租户侧中继接口；本机 node-session 鉴权，与其它 `/api/mesh/*` 路由一致。 */
export class RelayRoutes {
  constructor(private readonly deps: RelayRoutesDeps) {}

  mode(): 'relay' | 'hub' | 'none' {
    if (this.deps.secrets.uplinkKind() === 'relay') return 'relay';
    return this.deps.session.roles.hub || this.deps.session.roles.node ? 'hub' : 'none';
  }

  handle(req: Request, path: string): Promise<Response> | null {
    if (!path.startsWith(`${RELAY_ROUTE_PREFIX}/`)) return null;
    const route = `${req.method} ${path.slice(RELAY_ROUTE_PREFIX.length)}`;
    const handler = this.route(route);
    if (!handler) return Promise.resolve(jsonError('method_not_allowed', 405));
    if (isLocalRelayStatusRequest(req, path)) {
      return Promise.resolve(handler(req, ''));
    }
    return requireSession(this.deps.session, (r, auth) =>
      auth.userId ? handler(r, auth.userId) : jsonError('UNAUTHORIZED', 401)
    )(req);
  }

  private route(key: string): RelayRouteHandler | null {
    const table: Record<string, RelayRouteHandler> = {
      'GET /status': (_r, uid) => this.status(uid),
      'POST /switch': (r, uid) => handleRelaySwitch(this.deps, r, () => this.status(uid)),
      'GET /readmit/prepare': (_r, uid) => this.readmitPrepare(uid),
      'POST /enroll/proof-material': (r, uid) => this.proofMaterial(r, uid),
      'POST /enroll': (r, uid) => this.enroll(r, uid),
      'POST /leave/prepare': (_r, uid) => this.leavePrepare(uid),
      'POST /remove/prepare': (r, uid) => this.removePrepare(r, uid),
      'POST /meta-key/prepare': (r, uid) => this.metaKeyPrepare(r, uid),
      'GET /join-material': (r) => this.joinMaterial(r),
      'POST /enrollments': (r, uid) => this.createEnrollment(r, uid),
      'POST /pack': (r) =>
        handleMeshRelayPack(
          { secrets: this.deps.secrets, fetchImpl: this.deps.fetchImpl, dial: this.deps.dial },
          r
        ),
    };
    const direct = table[key];
    if (direct) return direct;
    const match = key.match(/^GET \/enrollments\/([^/]+)$/);
    if (!match) return null;
    const id = decodeURIComponent(match[1] ?? '');
    return (_r, uid) => this.getEnrollment(id, uid);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private relayClient(): RelayUplinkClient | null {
    const live = this.deps.uplink.liveClient();
    return live instanceof RelayUplinkClient ? live : null;
  }

  private async status(userId: string): Promise<Response> {
    const mode = this.mode();
    const client = this.relayClient();
    const live = this.deps.uplink.liveClient();
    const attached = this.deps.uplink.attachedHub();
    const rows = this.deps.secrets.relayRows();
    const uid = userId || this.deps.secrets.userId();
    const readmitPending = uid ? (await this.readmitPrepareFor(uid)).entries.length : 0;
    const candidates = this.deps.uplink.candidates();
    return jsonBody({
      mode,
      tenantId: this.deps.secrets.tenantId(),
      relays: rows.map((row) =>
        buildRelayStatusRow(row, attached?.publicUrl ?? null, client, live, candidates)
      ),
      metaEpoch: this.deps.secrets.currentMetaEpoch(),
      nodesViaRelay: client?.nodesViaRelay ?? 0,
      reauthRequired: rows.some((row) => row.kicked),
      readmitPending,
      quota: client?.quota ?? null,
      // 中继上的密钥日志由同租户节点写入；解不开的记录会被跳过，这里把健康度暴露给前端
      keyLog: client?.keyLogHealth() ?? { skipped: 0, blockedSeq: null, caughtUp: false },
    });
  }

  private async readmitPrepare(userId: string): Promise<Response> {
    if (!this.deps.userStore.getById(userId)) return jsonError('UNKNOWN_USER', 404);
    return jsonBody(await this.readmitPrepareFor(userId));
  }

  private async readmitPrepareFor(userId: string) {
    const user = this.deps.userStore.getById(userId);
    if (!user) return { rootEpoch: 0, entries: [] };
    const rows = await this.deps.keyLogService.list(userId, 1n);
    const bySeq = new Map(rows.map((row) => [Number(row.seq), row.bytes]));
    return buildReadmitPrepare({
      userStore: this.deps.userStore,
      userId,
      rootEpoch: user.rootEpoch,
      recordBytesAt: (seq) => bySeq.get(seq) ?? null,
    });
  }

  private async proofMaterial(req: Request, userId: string): Promise<Response> {
    const body = await readJsonObjectBody(req);
    const url = normalizeUrlOrNull(body?.url);
    if (!url) return jsonError('INVALID_URL', 400);
    const user = this.deps.userStore.getById(userId);
    if (!user) return jsonError('UNKNOWN_USER', 404);
    return jsonBody({
      url,
      relayHost: hubHostFromUrl(url),
      ts: this.now(),
      maxSkewMs: RELAY_ENROLL_PROOF_MAX_SKEW_MS,
      rootPublicKey: encodeBase64url(user.rootPublicKey),
      rootEpoch: user.rootEpoch,
    });
  }

  private async enroll(req: Request, userId: string): Promise<Response> {
    const body = await readJsonObjectBody(req);
    const url = normalizeUrlOrNull(body?.url);
    if (!url) return jsonError('INVALID_URL', 400);
    const user = this.deps.userStore.getById(userId);
    if (!user) return jsonError('UNKNOWN_USER', 404);
    const proof = readProof(body?.proof);
    if (!proof) return jsonError('MALFORMED', 400);
    const verified = verifyRelayEnrollProof({
      bytes: proof.bytes,
      sig: proof.sig,
      relayHost: hubHostFromUrl(url),
      rootPublicKey: user.rootPublicKey,
      now: this.now(),
    });
    if (!verified.ok) return jsonError('BAD_PROOF', 400, { reason: verified.error });
    const password = typeof body?.password === 'string' ? body.password : undefined;
    const remote = await this.callRelayEnroll(url, {
      password,
      rootPublicKey: user.rootPublicKey,
      rootEpoch: user.rootEpoch,
      proof,
    });
    if (!remote.ok) return jsonError(remote.error, remote.status);
    return this.prepareSetRelays(userId, {
      url,
      tenantId: remote.tenantId,
      token: remote.token,
      passwordEpoch: remote.passwordEpoch,
    });
  }

  private async callRelayEnroll(
    url: string,
    input: {
      password?: string;
      rootPublicKey: Uint8Array;
      rootEpoch: number;
      proof: { bytes: Uint8Array; sig: Uint8Array };
    }
  ): Promise<
    | { ok: true; tenantId: string; token: Uint8Array; passwordEpoch: number }
    | { ok: false; error: string; status: number }
  > {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const dialUrl = resolveRelayDialUrl(url, this.deps.dial ?? relayDialContextFromEnv());
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RELAY_ENROLL_FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(`${dialUrl.replace(/\/+$/, '')}/api/relay/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          ...(input.password !== undefined ? { password: input.password } : {}),
          root_public_key: encodeBase64url(input.rootPublicKey),
          root_epoch: input.rootEpoch,
          proof: {
            bytes: encodeBase64url(input.proof.bytes),
            sig: encodeBase64url(input.proof.sig),
          },
        }),
      });
      const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        const code = readRelayErrorCode(payload) ?? 'RELAY_ENROLL_FAILED';
        return { ok: false, error: code, status: res.status === 401 ? 401 : 502 };
      }
      const tenantId = typeof payload?.tenant_id === 'string' ? payload.tenant_id : '';
      const token = typeof payload?.token === 'string' ? payload.token : '';
      if (!/^[0-9a-f]{32}$/.test(tenantId) || !token) {
        return { ok: false, error: 'RELAY_BAD_RESPONSE', status: 502 };
      }
      const tokenBytes = decodeBase64url(token);
      if (tokenBytes.byteLength !== 32) {
        return { ok: false, error: 'RELAY_BAD_RESPONSE', status: 502 };
      }
      return {
        ok: true,
        tenantId,
        token: tokenBytes,
        passwordEpoch: typeof payload?.password_epoch === 'number' ? payload.password_epoch : 0,
      };
    } catch {
      return { ok: false, error: 'RELAY_UNREACHABLE', status: 502 };
    } finally {
      clearTimeout(timer);
    }
  }

  private async prepareSetRelays(
    userId: string,
    target: { url: string; tenantId: string; token: Uint8Array; passwordEpoch: number }
  ): Promise<Response> {
    const projection = this.deps.secrets.projection();
    const nodes = listRelayNodeKeys(this.deps.userStore, userId);
    if (nodes.length === 0) return jsonError('NO_ADMITTED_NODES', 409);
    const logKey = (await this.deps.secrets.logKey()) ?? generateTenantKey();
    const current = await this.deps.secrets.currentMetaKey();
    const metaKey = current?.key ?? generateTenantKey();
    const metaEpoch = current ? current.epoch : Math.max(1, projection.metaKeyEpoch);
    const relays = mergeRelayTargets(projection.relays, {
      url: target.url,
      tenantId: target.tenantId,
      token: target.token,
      priority: nextRelayPriority(projection.relays),
    });
    const payload = await buildSetRelaysPayload({ relays, logKey, metaKey, metaEpoch, nodes });
    const prepared = this.stash(payload, { logKey, metaKey, epoch: metaEpoch });
    const readmit = await this.readmitPrepareFor(userId);
    return jsonBody({
      tenantId: target.tenantId,
      token: encodeBase64url(target.token),
      passwordEpoch: target.passwordEpoch,
      metaEpoch,
      readmitRequired: readmit.entries.length,
      ...prepared,
    });
  }

  private async leavePrepare(userId: string): Promise<Response> {
    if (this.mode() !== 'relay') return jsonError('RELAY_NOT_CONFIGURED', 409);
    const projection = this.deps.secrets.projection();
    const payload = await buildSetRelaysPayload({
      relays: [],
      logKey: new Uint8Array(32),
      metaKey: new Uint8Array(32),
      metaEpoch: projection.metaKeyEpoch,
      nodes: listRelayNodeKeys(this.deps.userStore, userId),
    });
    return jsonBody({ metaEpoch: projection.metaKeyEpoch, ...this.stash(payload, null) });
  }

  /**
   * 摘掉多中继里的某一条：其余中继原样保留，优先级重排成 0..n-1。
   *
   * 与 `leave/prepare` 的区别是**必须继续分发密钥**——剩下的中继还要用同一套 `K_log` / `K_meta`，
   * 所以这里按 enroll 的套路把当前两把密钥重新封装给全部未吊销节点，世代不变（不是轮换）。
   * 只剩一条时不给走这条路：那等价于离开，`leave/prepare` 才是对的记录（空列表）。
   */
  private async removePrepare(req: Request, userId: string): Promise<Response> {
    if (this.mode() !== 'relay') return jsonError('RELAY_NOT_CONFIGURED', 409);
    const body = await readJsonObjectBody(req);
    const url = normalizeUrlOrNull(body?.url);
    if (!url) return jsonError('INVALID_URL', 400);
    const current = mergeRelayTargets(this.deps.secrets.projection().relays, null);
    if (!current.some((row) => row.url === url)) return jsonError('RELAY_NOT_FOUND', 404);
    if (current.length <= 1) return jsonError('RELAY_LAST', 409);
    const nodes = listRelayNodeKeys(this.deps.userStore, userId);
    if (nodes.length === 0) return jsonError('NO_ADMITTED_NODES', 409);
    const logKey = await this.deps.secrets.logKey();
    const meta = await this.deps.secrets.currentMetaKey();
    if (!logKey || !meta) return jsonError('RELAY_KEY_MISSING', 409);
    const relays = current
      .filter((row) => row.url !== url)
      .map((row, index) => ({ ...row, priority: index }));
    const payload = await buildSetRelaysPayload({
      relays,
      logKey,
      metaKey: meta.key,
      metaEpoch: meta.epoch,
      nodes,
    });
    const prepared = this.stash(payload, { logKey, metaKey: meta.key, epoch: meta.epoch });
    return jsonBody({ metaEpoch: meta.epoch, ...prepared });
  }

  private async metaKeyPrepare(req: Request, userId: string): Promise<Response> {
    if (this.mode() !== 'relay') return jsonError('RELAY_NOT_CONFIGURED', 409);
    const body = await readJsonObjectBody(req);
    const op = body?.op;
    if (op !== 'admit' && op !== 'rotate') return jsonError('MALFORMED', 400);
    const exclude =
      op === 'rotate' && Array.isArray(body?.exclude)
        ? body.exclude.filter((id): id is string => typeof id === 'string')
        : [];
    const nodes = listRelayNodeKeys(this.deps.userStore, userId, exclude);
    if (nodes.length === 0) return jsonError('NO_ADMITTED_NODES', 409);
    if (op === 'admit') {
      const nodeId = typeof body?.node_id === 'string' ? body.node_id : body?.nodeId;
      if (typeof nodeId !== 'string' || !nodes.some((node) => node.nodeId === nodeId)) {
        return jsonError('UNKNOWN_NODE', 404);
      }
    }
    const current = await this.deps.secrets.currentMetaKey();
    // `meta-key` 记录要求 epoch 严格递增：admit 复用当前密钥换新世代，rotate 换新密钥。
    const metaKey = op === 'admit' ? (current?.key ?? generateTenantKey()) : generateTenantKey();
    const epoch = this.deps.secrets.currentMetaEpoch() + 1;
    const payload = await buildMetaKeyPayload({ metaKey, epoch, nodes });
    return jsonBody({ epoch, ...this.stash(payload, { metaKey, epoch }) });
  }

  /**
   * 默认只给当前 attach 的那一台；`?scope=all` 给全表——密封包要按每台中继各自的租户编号与令牌分别封装。
   * 加节点向导应优先用 `POST /enrollments` 响应里已接受中继的 token，不必再打一次本接口。
   */
  private async joinMaterial(req: Request): Promise<Response> {
    if (this.mode() !== 'relay') return jsonError('RELAY_NOT_CONFIGURED', 409);
    const rows = this.deps.secrets.relayRows();
    const attachedUrl = this.deps.uplink.attachedHub()?.publicUrl ?? null;
    const all = new URL(req.url).searchParams.get('scope') === 'all';
    const attached = rows.find((row) => row.url === attachedUrl) ?? rows[0];
    if (!attached) return jsonError('RELAY_NOT_CONFIGURED', 409);
    const targets = all
      ? [attached, ...rows.filter((row) => row.url !== attached.url)]
      : [attached];
    const logKey = await this.deps.secrets.logKey();
    if (!logKey) return jsonError('RELAY_KEY_MISSING', 409);
    const relays = await collectJoinMaterialRelays(this.deps.secrets, targets);
    if (relays.length === 0) return jsonError('RELAY_KEY_MISSING', 409);
    return jsonBody({ logKey: encodeBase64url(logKey), relays });
  }

  private async createEnrollment(req: Request, userId: string): Promise<Response> {
    if (this.mode() !== 'relay') return jsonError('RELAY_NOT_CONFIGURED', 409);
    const rows = this.deps.secrets.relayRows();
    if (rows.length === 0) return jsonError('RELAY_NOT_CONFIGURED', 409);
    const prepared = await this.prepareLocalEnrollment(req, userId);
    if (prepared instanceof Response) return prepared;
    const client = this.relayClient();
    const attachedUrl = this.deps.uplink.attachedHub()?.publicUrl ?? null;
    const relays = await fanOutEnrollmentCreate({
      secrets: this.deps.secrets,
      rows,
      payload: prepared.payload,
      fetchImpl: this.deps.fetchImpl ?? fetch,
      dial: this.deps.dial ?? relayDialContextFromEnv(),
      timeoutMs: this.deps.enrollmentFanoutTimeoutMs ?? RELAY_ENROLLMENT_FANOUT_TIMEOUT_MS,
      attachedUrl,
      uplinkCreate:
        client?.state === 'online'
          ? () => client.createEnrollment(prepared.payload, RELAY_ENROLLMENT_ACK_TIMEOUT_MS)
          : undefined,
    });
    if (!relays.some((row) => row.accepted)) {
      this.deps.userStore.invalidateUnusedEnrollmentTokens(userId, this.now());
      return jsonError('RELAY_ENROLL_FANOUT_FAILED', 502, { relays });
    }
    return jsonBody(
      { ok: true, id: prepared.payload.id, expiresAt: prepared.payload.exp, relays },
      201
    );
  }

  private async prepareLocalEnrollment(
    req: Request,
    userId: string
  ): Promise<
    | Response
    | {
        payload: {
          id: string;
          enrollPk: Uint8Array;
          authorization: Uint8Array;
          authorizationSig: Uint8Array;
          exp: number;
        };
      }
  > {
    const body = await readJsonObjectBody(req);
    const parsed = parseEnrollmentBody(body);
    if (!parsed) return jsonError('MALFORMED', 400);
    if (!this.deps.userStore.getById(userId)) return jsonError('UNKNOWN_USER', 404);
    const authErr = await this.verifyAuthorization(userId, parsed);
    if (authErr) return jsonError(authErr, 400);
    const now = this.now();
    const expiresAt = Math.min(parsed.exp, parsed.bodyExp ?? parsed.exp);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return jsonError('EXPIRED', 400);
    if (this.deps.userStore.getEnrollmentTokenByEnrollPublicKey(parsed.enrollPk)) {
      return jsonError('DUPLICATE_ENROLL_PK', 409);
    }
    const token = this.deps.userStore.createEnrollmentToken({
      id: crypto.randomUUID(),
      userId,
      enrollPublicKey: parsed.enrollPk,
      authorizationJson: JSON.stringify({
        authorization_b64: encodeBase64url(parsed.authorization),
        entry_node_id: this.deps.nodeId,
      }),
      authorizationSig: parsed.authorizationSig,
      expiresAt,
    });
    return {
      payload: {
        id: token.id,
        enrollPk: parsed.enrollPk,
        authorization: parsed.authorization,
        authorizationSig: parsed.authorizationSig,
        exp: expiresAt,
      },
    };
  }

  private getEnrollment(id: string, userId: string): Response {
    const token = this.deps.userStore.getEnrollmentTokenById(id);
    if (!token || token.userId !== userId) return jsonError('NOT_FOUND', 404);
    const stored = parseStoredJson(token.authorizationJson);
    const redeemed = token.usedAt !== null;
    const nodeId = (typeof stored?.node_id === 'string' ? stored.node_id : null) ?? token.nodeId;
    const admitted = nodeId ? this.deps.userStore.getCert(nodeId) : null;
    const alreadyAdmitted = admitted?.revokedLogSeq === null;
    return jsonBody({
      status: redeemed ? 'redeemed' : 'pending',
      enroll_pk: encodeBase64url(token.enrollPublicKey),
      alreadyAdmitted,
      ...(nodeId ? { nodeId } : {}),
      ...(redeemed
        ? {
            certificate:
              alreadyAdmitted && admitted
                ? encodeBase64url(admitted.certificateBytes)
                : (stored?.certificate_b64 as string | undefined),
            cert_sig:
              alreadyAdmitted && admitted
                ? encodeBase64url(admitted.certSig)
                : (stored?.cert_sig_b64 as string | undefined),
          }
        : {}),
    });
  }

  private async verifyAuthorization(
    userId: string,
    parsed: ParsedEnrollment
  ): Promise<string | null> {
    const user = this.deps.userStore.getById(userId);
    if (!user) return 'UNKNOWN_USER';
    let authorization: ReturnType<typeof decodeAuthorization>;
    try {
      authorization = decodeAuthorization(parsed.authorization);
    } catch {
      return 'BAD_AUTHORIZATION';
    }
    if (authorization.uid !== user.id) return 'UID_MISMATCH';
    if (authorization.root_epoch !== user.rootEpoch) return 'EPOCH_MISMATCH';
    if (!bytesEqual(authorization.enroll_pk, parsed.enrollPk)) return 'ENROLL_PK_MISMATCH';
    if (authorization.signer === 'root') {
      const ok =
        parsed.authorizationSig.byteLength === 64 &&
        verifyEd25519(parsed.authorizationSig, parsed.authorization, user.rootPublicKey);
      return ok ? null : 'BAD_AUTHORIZATION_SIG';
    }
    if (authorization.signer !== 'passkey' || !authorization.credential_id) {
      return 'BAD_AUTHORIZATION';
    }
    const credentialId = authorization.credential_id;
    let credentialIdBytes: Uint8Array;
    try {
      credentialIdBytes = decodeBase64url(credentialId);
    } catch {
      return 'BAD_AUTHORIZATION';
    }
    const key = this.deps.userStore.getKeyByCredentialId(credentialIdBytes);
    if (!key || key.userId !== user.id) return 'UNKNOWN_PASSKEY';
    const ok = await makeVerifyPasskeyAssertion(this.deps.userStore)({
      recordBytes: parsed.authorization,
      sig: parsed.authorizationSig,
      credentialId,
      publicKey: key.publicKey,
      challenge: sha256(parsed.authorization),
    });
    return ok ? null : 'BAD_AUTHORIZATION_SIG';
  }

  private stash(
    payload: Uint8Array,
    keys: { logKey?: Uint8Array; metaKey: Uint8Array; epoch: number } | null
  ): PreparedPayload {
    const hash = relayPayloadHash(payload);
    if (keys) this.deps.secrets.stashPendingKeys(hash, keys);
    return { payload: encodeBase64url(payload), payloadHash: encodeBase64url(hash) };
  }
}
