import {
  bytesEqual,
  decodeAuthorization,
  decodeBase64url,
  decodeCertificate,
  decodeKeyLogRecord,
  decodeRevokeNodePayload,
  encodeBase64url,
  nodeIdToHex,
  sha256,
  verifyEd25519,
  verifyNodeCertificate,
} from '@tmex/shared/auth';
import { type LinkSession, type ServerSocketAdapter, WebSocketLink } from '@tmex/shared/link';
import { json, readJsonObjectBody } from '../api/http';
import { makeVerifyPasskeyAssertion } from '../auth/passkey';
import type { AuthDb } from '../auth/types';
import { UserStore } from '../auth/user-store';
import { detachEnrollmentTokensFromNode, patchNode } from './node-persistence';
import { NodeRegistry } from './node-registry';
import {
  HUB_AUTH_TIMEOUT_MS,
  HUB_HEARTBEAT_INTERVAL_MS,
  HUB_HEARTBEAT_MISS_LIMIT,
  HUB_UPLINK_PATH,
  HUB_UPLINK_WS_KIND,
  type HubAuthResult,
  type HubAuthenticate,
  type HubKeyLogSource,
  type HubRuntimeConfig,
  type HubUplinkSocketData,
} from './types';
import { b64urlToBytes } from './uplink-protocol';
import { type RegisterRtcSessionInput, UplinkServer } from './uplink-server';

export type HubUpgradeServer = {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
};

export type HubServerWebSocket = {
  data: HubUplinkSocketData & { adapter?: BunServerWsAdapter };
  send(data: Uint8Array | ArrayBuffer | ArrayBufferView | string): number | undefined;
  close(code?: number, reason?: string): void;
};

export type HubRuntimeOptions = {
  db: AuthDb;
  userStore: UserStore;
  keyLogSource: HubKeyLogSource;
  config: HubRuntimeConfig;
  authenticate: HubAuthenticate;
  now?: () => number;
  heartbeatIntervalMs?: number;
  heartbeatMissLimit?: number;
  authTimeoutMs?: number;
};

type StoredEnrollmentPayload = {
  authorization_b64: string;
  entry_node_id: string | null;
  entry_sid?: string | null;
  certificate_b64?: string;
  cert_sig_b64?: string;
  node_id?: string;
};

export class BunServerWsAdapter implements ServerSocketAdapter {
  private messageCb: ((bytes: Uint8Array) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;
  private drainCb: (() => void) | null = null;

  constructor(private readonly socket: HubServerWebSocket) {}

  send(bytes: Uint8Array): number {
    return this.socket.send(bytes) ?? bytes.byteLength;
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCb = cb;
  }

  onDrain(cb: () => void): void {
    this.drainCb = cb;
  }

  dispatchMessage(data: string | ArrayBuffer | Uint8Array): void {
    const bytes =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);
    this.messageCb?.(bytes);
  }

  dispatchClose(_code?: number, reason?: string): void {
    this.closeCb?.(reason);
  }

  dispatchDrain(): void {
    this.drainCb?.();
  }
}

export class HubRuntime {
  private readonly db: AuthDb;
  private readonly userStore: UserStore;
  private readonly keyLogSource: HubKeyLogSource;
  private readonly authenticate: HubAuthenticate;
  private readonly now: () => number;
  private readonly config: HubRuntimeConfig;
  readonly registry: NodeRegistry;
  readonly uplink: UplinkServer;

  constructor(opts: HubRuntimeOptions) {
    this.db = opts.db;
    this.userStore = opts.userStore;
    this.keyLogSource = opts.keyLogSource;
    this.authenticate = opts.authenticate;
    this.now = opts.now ?? Date.now;
    this.config = opts.config;
    this.registry = new NodeRegistry();
    this.uplink = new UplinkServer({
      db: opts.db,
      userStore: opts.userStore,
      keyLogSource: opts.keyLogSource,
      registry: this.registry,
      config: opts.config,
      now: this.now,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? HUB_HEARTBEAT_INTERVAL_MS,
      heartbeatMissLimit: opts.heartbeatMissLimit ?? HUB_HEARTBEAT_MISS_LIMIT,
      authTimeoutMs: opts.authTimeoutMs ?? HUB_AUTH_TIMEOUT_MS,
    });
  }

  attachLocalNode(link: LinkSession): void {
    this.uplink.accept(link);
  }

  registerRtcSession(input: RegisterRtcSessionInput): string | null {
    return this.uplink.registerRtcSession(input);
  }

  stop(): void {
    this.uplink.stop();
  }

  async handleRequest(req: Request, server: HubUpgradeServer): Promise<Response | undefined> {
    const path = new URL(req.url).pathname;
    if (path === HUB_UPLINK_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json({ error: 'method_not_allowed' }, 405);
      }
      const ok = server.upgrade(req, {
        data: { kind: HUB_UPLINK_WS_KIND } satisfies HubUplinkSocketData,
      });
      return ok ? undefined : json({ error: 'upgrade_failed' }, 500);
    }
    if (!path.startsWith('/api/hub/')) return undefined;
    if (path === '/api/hub/enrollments/redeem') {
      if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return this.handleRedeem(req);
    }
    if (path === '/api/hub/enrollments') {
      if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return this.withAuth(req, (auth) => this.handleCreateEnrollment(req, auth));
    }
    const enrollmentGet = path.match(/^\/api\/hub\/enrollments\/([^/]+)$/);
    if (enrollmentGet) {
      const enrollmentId = enrollmentGet[1];
      if (!enrollmentId || enrollmentId === 'redeem') {
        return json({ error: 'not_found' }, 404);
      }
      if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return this.withAuth(req, (auth) =>
        this.handleGetEnrollment(decodeURIComponent(enrollmentId), auth)
      );
    }
    if (path === '/api/hub/nodes') {
      if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return this.withAuth(req, (auth) => this.handleListNodes(auth));
    }
    const rename = path.match(/^\/api\/hub\/nodes\/([^/]+)\/rename$/);
    if (rename) {
      const nodeId = rename[1];
      if (!nodeId) return json({ error: 'not_found' }, 404);
      if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return this.withAuth(req, (auth) => this.handleRename(req, decodeURIComponent(nodeId), auth));
    }
    const revoke = path.match(/^\/api\/hub\/nodes\/([^/]+)\/revoke$/);
    if (revoke) {
      const nodeId = revoke[1];
      if (!nodeId) return json({ error: 'not_found' }, 404);
      if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return this.withAuth(req, (auth) => this.handleRevoke(req, decodeURIComponent(nodeId), auth));
    }
    return json({ error: 'not_found' }, 404);
  }

  handleUplinkOpen(ws: HubServerWebSocket): void {
    const adapter = new BunServerWsAdapter(ws);
    ws.data.adapter = adapter;
    const link = new WebSocketLink(adapter, { role: 'acceptor' });
    this.uplink.accept(link);
  }

  handleUplinkMessage(ws: HubServerWebSocket, message: string | ArrayBuffer | Uint8Array): void {
    ws.data.adapter?.dispatchMessage(message);
  }

  handleUplinkClose(ws: HubServerWebSocket, code?: number, reason?: string): void {
    ws.data.adapter?.dispatchClose(code, reason);
  }

  handleUplinkDrain(ws: HubServerWebSocket): void {
    ws.data.adapter?.dispatchDrain();
  }

  isUplinkSocket(ws: { data?: { kind?: string } }): boolean {
    return ws.data?.kind === HUB_UPLINK_WS_KIND;
  }

  private async withAuth(
    req: Request,
    handler: (auth: HubAuthResult) => Promise<Response> | Response
  ): Promise<Response> {
    const auth = await this.authenticate(req);
    if (!auth) return json({ error: 'unauthorized' }, 401);
    return handler(auth);
  }

  private handleListNodes(auth: HubAuthResult): Response {
    const nodes = this.userStore
      .listNodes()
      .filter((n) => n.userId === auth.userId)
      .map((n) => {
        const cert = this.userStore.getCert(n.id);
        const redeemed = parseStoredEnrollment(
          this.userStore.getEnrollmentTokenByNodeId(n.id)?.authorizationJson ?? ''
        );
        const certificate =
          redeemed?.certificate_b64 ?? (cert ? encodeBase64url(cert.certificateBytes) : undefined);
        const certSig =
          redeemed?.cert_sig_b64 ?? (cert ? encodeBase64url(cert.certSig) : undefined);
        return {
          id: n.id,
          name: n.name,
          status: n.status,
          online: Boolean(this.registry.get(n.id)?.authenticated),
          version: n.version,
          last_seen_at: n.lastSeenAt,
          direct_capable: n.directCapable,
          ...(certificate ? { certificate } : {}),
          ...(certSig ? { cert_sig: certSig } : {}),
        };
      });
    return json({ nodes });
  }

  private handleGetEnrollment(id: string, auth: HubAuthResult): Response {
    const token = this.userStore.getEnrollmentTokenById(id);
    if (!token || token.userId !== auth.userId) {
      return json({ error: 'not_found' }, 404);
    }
    const stored = parseStoredEnrollment(token.authorizationJson);
    const redeemed = token.usedAt !== null;
    const body: {
      status: 'pending' | 'redeemed';
      enroll_pk: string;
      certificate?: string;
      cert_sig?: string;
      node_id?: string;
    } = {
      status: redeemed ? 'redeemed' : 'pending',
      enroll_pk: encodeBase64url(token.enrollPublicKey),
    };
    if (redeemed) {
      if (stored?.certificate_b64) body.certificate = stored.certificate_b64;
      if (stored?.cert_sig_b64) body.cert_sig = stored.cert_sig_b64;
      const nodeId = stored?.node_id ?? token.nodeId;
      if (nodeId) body.node_id = nodeId;
    }
    return json(body);
  }

  private async handleRename(req: Request, nodeId: string, auth: HubAuthResult): Promise<Response> {
    const body = await readJsonObjectBody(req);
    const name = body?.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return json({ error: 'invalid_name' }, 400);
    }
    const node = this.userStore.getNode(nodeId);
    if (!node || node.userId !== auth.userId) {
      return json({ error: 'not_found' }, 404);
    }
    patchNode(this.db, nodeId, { name: name.trim() });
    this.registry.updateMeta(nodeId, { name: name.trim() }, this.now());
    await this.uplink.broadcastNodeList(auth.userId);
    return json({ ok: true, id: nodeId, name: name.trim() });
  }

  private async handleRevoke(req: Request, nodeId: string, auth: HubAuthResult): Promise<Response> {
    const cert = this.userStore.getCert(nodeId);
    if (!cert || cert.userId !== auth.userId) {
      return json({ error: 'not_found' }, 404);
    }
    const body = await readJsonObjectBody(req);
    if (!body) return json({ error: 'invalid_body' }, 400);
    let bytes: Uint8Array;
    let sig: Uint8Array;
    try {
      bytes = b64urlToBytes(requireBodyString(body, 'bytes'));
      sig = b64urlToBytes(requireBodyString(body, 'sig'), 64);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'invalid_fields' }, 400);
    }
    let record: ReturnType<typeof decodeKeyLogRecord>;
    try {
      record = decodeKeyLogRecord(bytes);
    } catch {
      return json({ error: 'bad_record' }, 400);
    }
    if (record.type !== 'revoke-node') {
      return json({ error: 'not_revoke_node' }, 400);
    }
    let payload: ReturnType<typeof decodeRevokeNodePayload>;
    try {
      payload = decodeRevokeNodePayload(record.payload);
    } catch {
      return json({ error: 'bad_payload' }, 400);
    }
    if (nodeIdToHex(payload.node_id) !== nodeId) {
      return json({ error: 'node_mismatch' }, 400);
    }
    const result = await this.keyLogSource.append(auth.userId, { bytes, sig });
    if (!result.ok) {
      return json({ error: result.error }, 400);
    }
    await this.uplink.applyAppendEffects(auth.userId, result);
    return json({ ok: true, id: nodeId, status: 'revoked' });
  }

  private async handleCreateEnrollment(req: Request, auth: HubAuthResult): Promise<Response> {
    const body = await readJsonObjectBody(req);
    if (!body) return json({ error: 'invalid_body' }, 400);
    const user = this.userStore.getById(auth.userId);
    if (!user) return json({ error: 'user_not_found' }, 404);
    let enrollPk: Uint8Array;
    let authorizationBytes: Uint8Array;
    let authorizationSig: Uint8Array;
    try {
      enrollPk = b64urlToBytes(requireBodyString(body, 'enroll_pk'), 32);
      authorizationBytes = b64urlToBytes(requireBodyString(body, 'authorization'));
      authorizationSig = b64urlToBytes(requireBodyString(body, 'authorization_sig'));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'invalid_fields' }, 400);
    }
    let authorization: ReturnType<typeof decodeAuthorization>;
    try {
      authorization = decodeAuthorization(authorizationBytes);
    } catch {
      return json({ error: 'bad_authorization' }, 400);
    }
    if (authorization.uid !== user.id) {
      return json({ error: 'uid_mismatch' }, 400);
    }
    if (authorization.root_epoch !== user.rootEpoch) {
      return json({ error: 'epoch_mismatch' }, 400);
    }
    if (!bytesEqual(authorization.enroll_pk, enrollPk)) {
      return json({ error: 'enroll_pk_mismatch' }, 400);
    }
    if (authorization.signer === 'root') {
      if (
        authorizationSig.byteLength !== 64 ||
        !verifyEd25519(authorizationSig, authorizationBytes, user.rootPublicKey)
      ) {
        return json({ error: 'bad_authorization_sig' }, 400);
      }
    } else if (authorization.signer === 'passkey') {
      const credentialId = authorization.credential_id;
      if (!credentialId) {
        return json({ error: 'missing_credential_id' }, 400);
      }
      let credentialIdBytes: Uint8Array;
      try {
        credentialIdBytes = decodeBase64url(credentialId);
      } catch {
        return json({ error: 'bad_authorization' }, 400);
      }
      const storedKey = this.userStore.getKeyByCredentialId(credentialIdBytes);
      if (!storedKey || storedKey.userId !== user.id) {
        return json({ error: 'unknown_passkey' }, 400);
      }
      const verify = makeVerifyPasskeyAssertion(this.userStore);
      const ok = await verify({
        recordBytes: authorizationBytes,
        sig: authorizationSig,
        credentialId,
        publicKey: storedKey.publicKey,
        challenge: sha256(authorizationBytes),
      });
      if (!ok) {
        return json({ error: 'bad_authorization_sig' }, 400);
      }
    } else {
      return json({ error: 'bad_authorization' }, 400);
    }
    const now = this.now();
    const authExp = Number(authorization.exp);
    const bodyExp = typeof body.exp === 'number' ? body.exp : authExp;
    const expiresAt = Math.min(authExp, bodyExp);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      return json({ error: 'expired' }, 400);
    }
    if (this.userStore.getEnrollmentTokenByEnrollPublicKey(enrollPk)) {
      return json({ error: 'duplicate_enroll_pk' }, 409);
    }
    const payload: StoredEnrollmentPayload = {
      authorization_b64: encodeBase64url(authorizationBytes),
      entry_node_id: auth.entryNodeId,
      ...(auth.sid ? { entry_sid: auth.sid } : {}),
    };
    const token = this.userStore.createEnrollmentToken({
      id: crypto.randomUUID(),
      userId: user.id,
      enrollPublicKey: enrollPk,
      authorizationJson: JSON.stringify(payload),
      authorizationSig,
      expiresAt,
    });
    return json(
      {
        ok: true,
        id: token.id,
        expires_at: expiresAt,
        public_url: this.config.publicUrl,
      },
      201
    );
  }

  private async handleRedeem(req: Request): Promise<Response> {
    const body = await readJsonObjectBody(req);
    if (!body) return json({ error: 'invalid_body' }, 400);
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'node';
    const version = typeof body.version === 'string' ? body.version : '';
    let certBytes: Uint8Array;
    let certSig: Uint8Array;
    try {
      certBytes = b64urlToBytes(requireBodyString(body, 'certificate'));
      certSig = b64urlToBytes(requireBodyString(body, 'cert_sig'), 64);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'invalid_fields' }, 400);
    }
    let certificate: ReturnType<typeof decodeCertificate>;
    try {
      certificate = decodeCertificate(certBytes);
    } catch {
      return json({ error: 'bad_certificate' }, 400);
    }
    const token = this.userStore.getEnrollmentTokenByEnrollPublicKey(certificate.enroll_pk);
    if (!token) {
      return json({ error: 'unknown_enrollment' }, 400);
    }
    if (!verifyNodeCertificate(certBytes, certSig, token.enrollPublicKey)) {
      return json({ error: 'bad_cert_sig' }, 400);
    }
    const stored = parseStoredEnrollment(token.authorizationJson);
    if (!stored) {
      return json({ error: 'bad_token' }, 400);
    }
    let authorization: ReturnType<typeof decodeAuthorization>;
    try {
      authorization = decodeAuthorization(b64urlToBytes(stored.authorization_b64));
    } catch {
      return json({ error: 'bad_authorization' }, 400);
    }
    if (!bytesEqual(authorization.enroll_pk, certificate.enroll_pk)) {
      return json({ error: 'enroll_pk_mismatch' }, 400);
    }
    if (authorization.uid !== certificate.uid || authorization.uid !== token.userId) {
      return json({ error: 'uid_mismatch' }, 400);
    }
    const hexId = nodeIdToHex(certificate.node_id);
    const now = this.now();
    const providedName =
      typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
    let replayUserId: string | null = null;
    let replacedExisting = false;
    try {
      this.db.transaction((tx) => {
        const authDb = tx as AuthDb;
        const store = new UserStore(authDb);
        const fresh = store.getEnrollmentTokenByEnrollPublicKey(certificate.enroll_pk);
        if (!fresh) {
          throw new RedeemAbort('unknown_enrollment', 400);
        }
        if (fresh.usedAt !== null) {
          const prev = parseStoredEnrollment(fresh.authorizationJson);
          if (
            prev?.certificate_b64 === encodeBase64url(certBytes) &&
            prev?.cert_sig_b64 === encodeBase64url(certSig)
          ) {
            throw new RedeemReplay(fresh.userId);
          }
          throw new RedeemAbort('reused', 400);
        }
        const userRow = store.getById(fresh.userId);
        if (!userRow) {
          throw new RedeemAbort('user_not_found', 500);
        }
        if (authorization.root_epoch !== userRow.rootEpoch) {
          throw new RedeemAbort('epoch_mismatch', 400);
        }
        if (fresh.expiresAt <= now) {
          throw new RedeemAbort('expired', 400);
        }
        const existing = store.getNode(hexId);
        if (existing) {
          if (existing.userId !== fresh.userId) {
            throw new RedeemAbort('node_exists', 409);
          }
          const existingPk = readNodeEdPublicKey(store, hexId);
          if (!existingPk || !bytesEqual(existingPk, certificate.ed_pk)) {
            throw new RedeemAbort('node_exists', 409);
          }
          detachEnrollmentTokensFromNode(authDb, hexId);
        }
        const consumed = store.consumeEnrollmentToken(certificate.enroll_pk, {
          nodeId: hexId,
          now,
          authorizationJson: JSON.stringify({
            ...stored,
            certificate_b64: encodeBase64url(certBytes),
            cert_sig_b64: encodeBase64url(certSig),
            node_id: hexId,
          } satisfies StoredEnrollmentPayload),
        });
        if (!consumed) {
          throw new RedeemAbort('reused', 400);
        }
        if (existing) {
          patchNode(authDb, hexId, {
            status: 'enrolled',
            ...(providedName ? { name: providedName } : {}),
            ...(version ? { version } : {}),
          });
          replacedExisting = true;
        } else {
          store.createNode({
            id: hexId,
            userId: fresh.userId,
            name,
            status: 'enrolled',
            version: version || null,
            now,
          });
        }
      });
    } catch (err) {
      if (err instanceof RedeemReplay) {
        replayUserId = err.userId;
      } else if (err instanceof RedeemAbort) {
        return json({ error: err.error }, err.status);
      } else {
        throw err;
      }
    }
    if (replacedExisting) {
      this.registry.updateMeta(
        hexId,
        {
          ...(providedName ? { name: providedName } : {}),
          ...(version ? { version } : {}),
        },
        now
      );
    }
    if (!replayUserId && stored.entry_node_id) {
      this.uplink.sendTo(stored.entry_node_id, {
        t: 'enroll.redeemed',
        certificate: encodeBase64url(certBytes),
        cert_sig: encodeBase64url(certSig),
        enroll_pk: encodeBase64url(certificate.enroll_pk),
        node_id: hexId,
        ...(stored.entry_sid ? { entry_sid: stored.entry_sid } : {}),
      });
    }
    if (replacedExisting) {
      await this.uplink.broadcastNodeList(token.userId);
    }
    return this.redeemSuccessPayload(replayUserId ?? token.userId);
  }

  private async redeemSuccessPayload(userId: string): Promise<Response> {
    const user = this.userStore.getById(userId);
    if (!user) {
      return json({ error: 'user_not_found' }, 500);
    }
    const records = await this.keyLogSource.list(user.id);
    const certs = this.userStore.listCerts().filter((c) => c.userId === user.id);
    return json({
      user: {
        id: user.id,
        username: user.username,
        root_public_key: encodeBase64url(user.rootPublicKey),
        root_epoch: user.rootEpoch,
        kdf_params: parseKdfParams(user.kdfParamsJson),
      },
      user_key_log: records.map((r) => ({
        seq: Number(r.seq) <= Number.MAX_SAFE_INTEGER ? Number(r.seq) : r.seq.toString(),
        bytes: encodeBase64url(r.bytes),
        sig: encodeBase64url(r.sig),
      })),
      node_certs: certs.map((c) => ({
        node_id: c.nodeId,
        user_id: c.userId,
        admit_record_seq: c.admitRecordSeq,
        certificate: encodeBase64url(c.certificateBytes),
        cert_sig: encodeBase64url(c.certSig),
        authorization: encodeBase64url(c.authorizationBytes),
        authorization_sig: encodeBase64url(c.authorizationSig),
        revoked_log_seq: c.revokedLogSeq,
      })),
    });
  }
}

class RedeemAbort extends Error {
  constructor(
    readonly error: string,
    readonly status: number
  ) {
    super(error);
    this.name = 'RedeemAbort';
  }
}

class RedeemReplay extends Error {
  constructor(readonly userId: string) {
    super('redeem-replay');
    this.name = 'RedeemReplay';
  }
}

function requireBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing ${key}`);
  }
  return value;
}

function parseStoredEnrollment(raw: string): StoredEnrollmentPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.authorization_b64 !== 'string') return null;
    return {
      authorization_b64: obj.authorization_b64,
      entry_node_id: typeof obj.entry_node_id === 'string' ? obj.entry_node_id : null,
      entry_sid: typeof obj.entry_sid === 'string' ? obj.entry_sid : undefined,
      certificate_b64: typeof obj.certificate_b64 === 'string' ? obj.certificate_b64 : undefined,
      cert_sig_b64: typeof obj.cert_sig_b64 === 'string' ? obj.cert_sig_b64 : undefined,
      node_id: typeof obj.node_id === 'string' ? obj.node_id : undefined,
    };
  } catch {
    return null;
  }
}

function readNodeEdPublicKey(store: UserStore, nodeId: string): Uint8Array | null {
  const cert = store.getCert(nodeId);
  const fromCert = cert ? decodeCertificateEdPk(cert.certificateBytes) : null;
  if (fromCert) return fromCert;
  const token = store.getEnrollmentTokenByNodeId(nodeId);
  const stored = parseStoredEnrollment(token?.authorizationJson ?? '');
  if (!stored?.certificate_b64) return null;
  try {
    return decodeCertificateEdPk(decodeBase64url(stored.certificate_b64));
  } catch {
    return null;
  }
}

function decodeCertificateEdPk(bytes: Uint8Array): Uint8Array | null {
  try {
    return decodeCertificate(bytes).ed_pk;
  } catch {
    return null;
  }
}

function parseKdfParams(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
