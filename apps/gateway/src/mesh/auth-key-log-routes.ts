import {
  type Delegation,
  applyKeyLogRecord,
  bytesEqual,
  computeRecordHash,
  decodeBase64url,
  decodeKeyLogRecord,
  encodeBase64url,
  verifyKeyLogRecord,
} from '@tmex/shared/auth';
import { HUB_NOT_WRITER } from '@tmex/shared/uplink';
import { readJsonObjectBody } from '../api/http';
import { requiredStrings } from '../api/route-input';
import { pickWriterHub } from '../auth/mesh-hub-store';
import { makeVerifyPasskeyAssertion } from '../auth/passkey';
import type { UserRecord } from '../auth/user-store';
import {
  applyForcedKeyLogCompat,
  filterNotRetiredHubRecords,
  inspectHubAuthRecordCompat,
} from '../hub/hub-authorization';
import type { AuthRoutesDeps } from './auth-routes';
import { clientIpFromRequest } from './client-ip';
import { isPeerRequest } from './client-source';
import type { KeyLogHubAck } from './mesh-deps';
import { jsonBody, jsonError } from './session-middleware';
import { sameHubUrl } from './uplink-pool';

export type LoginFailureSink = {
  noteUidHint: (uid: string) => void;
  fail: (code: string, status?: number) => Response;
  precheck: (body: Record<string, unknown> | null) => Response | null;
  rejectUid: () => Response | null;
};

export function loginRequestContext(req: Request): { peer: boolean; ip: string } {
  const peer = isPeerRequest(req);
  const ip = peer ? '' : (clientIpFromRequest(req) ?? 'local');
  return { peer, ip };
}

export function createLoginFailureSink(
  deps: {
    recordFailure: (key: string) => void;
    loginLimited: (uidHint: string, ip: string) => boolean;
    peekUid: (body: Record<string, unknown>) => string;
    uidTooLong: (uid: string) => boolean;
  },
  ctx: { peer: boolean; ip: string }
): LoginFailureSink {
  const { ip } = ctx;
  let uidHint = '';
  const noteUidHint = (uid: string) => {
    uidHint = uid;
  };
  const fail = (code: string, status = 401): Response => {
    if (code !== 'TOTP_REQUIRED' && code !== 'PASSKEY_REQUIRED') {
      if (ip) deps.recordFailure(`ip:${ip}`);
      if (uidHint) deps.recordFailure(`uid:${uidHint}`);
    }
    return jsonError(code, status);
  };
  const rejectUid = (): Response | null => {
    if (uidHint && deps.uidTooLong(uidHint)) return jsonError('MALFORMED', 400);
    if (deps.loginLimited(uidHint, ip)) return jsonError('RATE_LIMITED', 429);
    return null;
  };
  const precheck = (body: Record<string, unknown> | null): Response | null => {
    if (!body) {
      if (ip) deps.recordFailure(`ip:${ip}`);
      return jsonError('MALFORMED', 400);
    }
    noteUidHint(deps.peekUid(body));
    return rejectUid();
  };
  return { noteUidHint, fail, precheck, rejectUid };
}

type SecondFactorResult = { ok: true } | { ok: false; code: string };

export async function verifySecondFactors(args: {
  checkTotp: (
    user: UserRecord,
    method: Delegation['method'],
    totpBody: unknown
  ) => Promise<SecondFactorResult>;
  checkPasskeySecondFactor: (
    req: Request,
    user: UserRecord,
    delegation: Delegation,
    passkeyBody: unknown
  ) => Promise<SecondFactorResult>;
  req: Request;
  user: UserRecord;
  delegation: Delegation;
  body: Record<string, unknown>;
}): Promise<SecondFactorResult> {
  const totpCheck = await args.checkTotp(args.user, args.delegation.method, args.body.totp);
  if (!totpCheck.ok) return totpCheck;
  const passkeyCheck = await args.checkPasskeySecondFactor(
    args.req,
    args.user,
    args.delegation,
    args.body.passkey
  );
  if (!passkeyCheck.ok) return passkeyCheck;
  return { ok: true };
}

export type AuthKeyLogHost = {
  invalidateAuthModeCache: () => void;
  getForwardWriterWrite: () => ((req: Request, uid?: string) => Promise<Response | null>) | null;
};

export class AuthKeyLogRoutes {
  constructor(
    private readonly deps: AuthRoutesDeps,
    private readonly host: AuthKeyLogHost
  ) {}

  handleKeyLogHead(userId: string | null): Response {
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

  async handleKeyLog(req: Request, userId: string | null): Promise<Response> {
    if (!userId) return jsonError('UNAUTHORIZED', 401);
    if (this.deps.roles.hub && this.deps.hubMode?.() === 'standby') {
      const forwarded = await this.host.getForwardWriterWrite()?.(req, userId);
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

  resolveHub(): { nodeId: string | null; publicUrl: string | null } {
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
    this.host.invalidateAuthModeCache();
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
    const compat = applyForcedKeyLogCompat(
      inspectHubAuthRecordCompat(this.deps.userStore, bytes, userId),
      req.headers.get('x-tmex-force-keylog') === '1'
    );
    if (compat.ok) return null;
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
}

function seqToJson(seq: bigint | number): number | string {
  const value = typeof seq === 'bigint' ? seq : BigInt(seq);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
