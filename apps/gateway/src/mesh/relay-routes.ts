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
  normalizeRelayUrl,
  verifyRelayEnrollProof,
} from '@tmex/shared/relay';
import { readJsonObjectBody } from '../api/http';
import type { UserKeyService } from '../auth';
import { makeVerifyPasskeyAssertion } from '../auth/passkey';
import type { UserStore } from '../auth/user-store';
import {
  buildMetaKeyPayload,
  buildSetRelaysPayload,
  listRelayNodeKeys,
  mergeRelayTargets,
  nextRelayPriority,
  relayPayloadHash,
} from './relay-payloads';
import type { RelaySecrets } from './relay-secrets';
import { RelayUplinkClient } from './relay-uplink-client';
import {
  type SessionMiddlewareDeps,
  jsonBody,
  jsonError,
  requireSession,
} from './session-middleware';
import type { PooledUplink } from './types';
import type { AttachedHub } from './uplink-pool';

export const RELAY_ROUTE_PREFIX = '/api/mesh/relay';
export const RELAY_ENROLL_FETCH_TIMEOUT_MS = 15_000;
export const RELAY_ENROLLMENT_ACK_TIMEOUT_MS = 10_000;

export type RelayUplinkView = {
  liveClient(): PooledUplink | null;
  attachedHub(): AttachedHub | null;
  reconfigure(): Promise<void>;
};

export type RelayRoutesDeps = {
  session: SessionMiddlewareDeps;
  nodeId: string;
  userStore: UserStore;
  keyLogService: UserKeyService;
  secrets: RelaySecrets;
  uplink: RelayUplinkView;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type PreparedPayload = { payload: string; payloadHash: string };
type RelayRouteHandler = (req: Request, userId: string) => Promise<Response> | Response;

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
    return requireSession(this.deps.session, (r, auth) =>
      auth.userId ? handler(r, auth.userId) : jsonError('UNAUTHORIZED', 401)
    )(req);
  }

  private route(key: string): RelayRouteHandler | null {
    const table: Record<string, RelayRouteHandler> = {
      'GET /status': () => this.status(),
      'POST /enroll/proof-material': (r, uid) => this.proofMaterial(r, uid),
      'POST /enroll': (r, uid) => this.enroll(r, uid),
      'POST /leave/prepare': (_r, uid) => this.leavePrepare(uid),
      'POST /meta-key/prepare': (r, uid) => this.metaKeyPrepare(r, uid),
      'GET /join-material': () => this.joinMaterial(),
      'POST /enrollments': (r, uid) => this.createEnrollment(r, uid),
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

  private status(): Response {
    const mode = this.mode();
    const client = this.relayClient();
    const attached = this.deps.uplink.attachedHub();
    const rows = this.deps.secrets.relayRows();
    return jsonBody({
      mode,
      tenantId: this.deps.secrets.tenantId(),
      relays: rows.map((row) => ({
        url: row.url,
        priority: row.priority,
        online: attached?.publicUrl === row.url && client?.state === 'online',
        attached: attached?.publicUrl === row.url,
        rttMs: null,
        lastError:
          attached?.publicUrl === row.url ? (client?.lastConnectError?.reason ?? null) : null,
        kicked: row.kicked,
      })),
      metaEpoch: this.deps.secrets.currentMetaEpoch(),
      nodesViaRelay: client?.nodesViaRelay ?? 0,
      reauthRequired: rows.some((row) => row.kicked),
      quota: client?.quota ?? null,
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
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RELAY_ENROLL_FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(`${url.replace(/\/+$/, '')}/api/relay/enroll`, {
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
        const code = typeof payload?.code === 'string' ? payload.code : 'RELAY_ENROLL_FAILED';
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
    return jsonBody({
      tenantId: target.tenantId,
      token: encodeBase64url(target.token),
      passwordEpoch: target.passwordEpoch,
      metaEpoch,
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

  private async joinMaterial(): Promise<Response> {
    if (this.mode() !== 'relay') return jsonError('RELAY_NOT_CONFIGURED', 409);
    const rows = this.deps.secrets.relayRows();
    const first = rows[0];
    if (!first) return jsonError('RELAY_NOT_CONFIGURED', 409);
    const relay = await this.deps.secrets.store.getRelay(first.url);
    const logKey = await this.deps.secrets.logKey();
    if (!relay || !logKey) return jsonError('RELAY_KEY_MISSING', 409);
    return jsonBody({
      tenantId: relay.tenantId,
      token: encodeBase64url(relay.token),
      logKey: encodeBase64url(logKey),
      relays: rows.map((row) => row.url),
    });
  }

  private async createEnrollment(req: Request, userId: string): Promise<Response> {
    if (this.mode() !== 'relay') return jsonError('RELAY_NOT_CONFIGURED', 409);
    const client = this.relayClient();
    if (!client || client.state !== 'online') return jsonError('RELAY_OFFLINE', 503);
    const body = await readJsonObjectBody(req);
    const parsed = parseEnrollmentBody(body);
    if (!parsed) return jsonError('MALFORMED', 400);
    const user = this.deps.userStore.getById(userId);
    if (!user) return jsonError('UNKNOWN_USER', 404);
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
    const ack = await client.createEnrollment(
      {
        id: token.id,
        enrollPk: parsed.enrollPk,
        authorization: parsed.authorization,
        authorizationSig: parsed.authorizationSig,
        exp: expiresAt,
      },
      RELAY_ENROLLMENT_ACK_TIMEOUT_MS
    );
    if (!ack.ok) {
      this.deps.userStore.invalidateUnusedEnrollmentTokens(userId, expiresAt + 1);
      return jsonError(ack.error ?? 'RELAY_REJECTED', 502);
    }
    return jsonBody(
      {
        ok: true,
        id: token.id,
        expiresAt,
        relays: this.deps.secrets.relayRows().map((row) => row.url),
      },
      201
    );
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

type ParsedEnrollment = {
  enrollPk: Uint8Array;
  authorization: Uint8Array;
  authorizationSig: Uint8Array;
  exp: number;
  bodyExp?: number;
};

function parseEnrollmentBody(body: Record<string, unknown> | null): ParsedEnrollment | null {
  if (!body) return null;
  try {
    const enrollPk = decodeBase64url(String(body.enroll_pk ?? ''));
    const authorization = decodeBase64url(String(body.authorization ?? ''));
    const authorizationSig = decodeBase64url(String(body.authorization_sig ?? ''));
    if (enrollPk.byteLength !== 32 || authorization.byteLength === 0) return null;
    const decoded = decodeAuthorization(authorization);
    return {
      enrollPk,
      authorization,
      authorizationSig,
      exp: Number(decoded.exp),
      ...(typeof body.exp === 'number' ? { bodyExp: body.exp } : {}),
    };
  } catch {
    return null;
  }
}

function parseStoredJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return normalizeRelayUrl(value.trim());
  } catch {
    return null;
  }
}

function readProof(value: unknown): { bytes: Uint8Array; sig: Uint8Array } | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { bytes?: unknown; sig?: unknown };
  if (typeof raw.bytes !== 'string' || typeof raw.sig !== 'string') return null;
  try {
    const bytes = decodeBase64url(raw.bytes);
    const sig = decodeBase64url(raw.sig);
    if (sig.byteLength !== 64 || bytes.byteLength === 0) return null;
    return { bytes, sig };
  } catch {
    return null;
  }
}
