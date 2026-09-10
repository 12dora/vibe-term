import {
  type KeyLogEffect,
  RELAY_RECORD_TYPES,
  applyKeyLogRecord,
  bytesEqual,
  computeRecordHash,
  decodeBase64url,
  decodeKeyLogRecord,
  encodeBase64url,
  verifyKeyLogRecord,
} from '@vibeterm/shared/auth';
import { FORCE_KEYLOG_HEADER, readHeaderPair } from '@vibeterm/shared/http/mesh-headers';
import { HUB_NOT_WRITER } from '@vibeterm/shared/uplink';
import { readJsonObjectBody } from '../api/http';
import { requiredStrings } from '../api/route-input';
import { pickWriterHub } from '../auth/mesh-hub-store';
import { makeDeferredVerifyPasskeyAssertion } from '../auth/passkey';
import {
  applyForcedKeyLogCompat,
  filterNotRetiredHubRecords,
  inspectHubAuthRecordCompat,
} from '../hub/hub-authorization';
import { isLoopbackHostLiteral } from './address-class';
import { logAuthLoginFailed, logAuthSessionRevokes } from './auth-audit-log';
import { findPrimaryUser } from './auth-mode-cache';
import type { AuthRoutesDeps } from './auth-routes';
import { clientIpFromRequest } from './client-ip';
import { isPeerRequest } from './client-source';
import type { KeyLogHubAck } from './mesh-deps';
import { jsonBody, jsonError } from './session-middleware';
import { sameHubUrl } from './uplink-pool';

export type LoginFailureSink = {
  noteUidHint: (uid: string) => void;
  fail: (code: string, status?: number, logCode?: string) => Response;
  precheck: (body: Record<string, unknown> | null) => Response | null;
  rejectUid: () => Response | null;
};

/**
 * 装配期的 `hubPublicUrl` 在没有任何 Hub 配置时会兜底成 `http://127.0.0.1`：那只服务上联拨号，
 * 摆进 `/api/auth/mode` 会被界面当成可访问的 Hub 入口。回环一律视为「没有」。
 */
function usableHubUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || isLoopbackHostLiteral(host)) return null;
  } catch {
    return null;
  }
  return url;
}

export function loginRequestContext(req: Request): { peer: boolean; ip: string } {
  const peer = isPeerRequest(req);
  // 入口 forwarder 会丢掉 x-forwarded-* / CF-Connecting-IP，目标节点看到的是
  // `peer:<入口>`。对端自带的转发头也不可信（成员节点可伪造），因此转发登录的
  // IP 桶留空，只按 uid 计；真实客户端 IP 的限速在入口执行。
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
  const fail = (code: string, status?: number, logCode?: string): Response => {
    logAuthLoginFailed({ uid: uidHint, code: logCode ?? code, ip });
    if (code === 'RATE_LIMITED') return jsonError(code, status ?? 429);
    if (code !== 'TOTP_REQUIRED' && code !== 'PASSKEY_REQUIRED') {
      if (ip) deps.recordFailure(`ip:${ip}`);
      if (uidHint) deps.recordFailure(`uid:${uidHint}`);
    }
    return jsonError(code, status ?? 401);
  };
  const rejectUid = (): Response | null => {
    if (uidHint && deps.uidTooLong(uidHint)) {
      logAuthLoginFailed({ uid: uidHint, code: 'MALFORMED', ip });
      return jsonError('MALFORMED', 400);
    }
    if (deps.loginLimited(uidHint, ip)) {
      logAuthLoginFailed({ uid: uidHint, code: 'RATE_LIMITED', ip });
      return jsonError('RATE_LIMITED', 429);
    }
    return null;
  };
  const precheck = (body: Record<string, unknown> | null): Response | null => {
    if (!body) {
      if (ip) deps.recordFailure(`ip:${ip}`);
      logAuthLoginFailed({ uid: uidHint, code: 'MALFORMED', ip });
      return jsonError('MALFORMED', 400);
    }
    noteUidHint(deps.peekUid(body));
    return rejectUid();
  };
  return { noteUidHint, fail, precheck, rejectUid };
}

export { verifySecondFactors } from './auth-passkey-origin';

export type AuthKeyLogHost = {
  invalidateAuthModeCache: () => void;
  getForwardWriterWrite: () => ((req: Request, uid?: string) => Promise<Response | null>) | null;
};

/**
 * `set-relays` / `meta-key` 定义的是上级本身：首次接中继时还没有中继可问，被踢之后旧令牌已死，
 * hub → 中继迁移更不该要求旧 hub 认得这个类型。这两类记录一律本地优先落账。
 */
const UPLINK_DEFINING_RECORDS: ReadonlySet<string> = new Set<string>(RELAY_RECORD_TYPES);

export function definesUplink(bytes: Uint8Array): boolean {
  try {
    return UPLINK_DEFINING_RECORDS.has(decodeKeyLogRecord(bytes).type);
  } catch {
    return false;
  }
}

export type KeyLogAppendPlan = {
  /** 本地日志权威：先落账再推给上级，上级确认不影响本地提交。 */
  localFirst: boolean;
  /** 是否把记录发给当前上级（迁移中的 set-relays 不能回灌旧 hub）。 */
  publish: boolean;
};

/**
 * 中继模式下本地成员表/密钥日志是权威，先本地提交，再通过 relayAck 单独报告中继确认。
 * hub 模式只有 `set-relays` / `meta-key` 走本地优先。`readmit-node` 与 `admit-node` 一样：
 * 任意模式都 publish；hub 模式走 writer（`localFirst: false`）。
 */
export function planKeyLogAppend(input: {
  relayMode: boolean;
  bytes: Uint8Array;
}): KeyLogAppendPlan {
  const defining = definesUplink(input.bytes);
  return { localFirst: input.relayMode || defining, publish: input.relayMode || !defining };
}

async function readKeyLogAppend(
  req: Request
): Promise<{ bytes: Uint8Array; sig: Uint8Array; force: boolean } | null> {
  const body = await readJsonObjectBody(req);
  const fields = body && requiredStrings(body, ['bytes', 'sig']);
  if (!fields) return null;
  try {
    return {
      bytes: decodeBase64url(fields.bytes),
      sig: decodeBase64url(fields.sig),
      force: readHeaderPair(req.headers, FORCE_KEYLOG_HEADER) === '1',
    };
  } catch {
    return null;
  }
}

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
    const record = await readKeyLogAppend(req);
    if (!record) return jsonError('MALFORMED', 400);
    return this.appendKeyLog(req, userId, record);
  }

  private async appendKeyLog(
    req: Request,
    userId: string,
    record: { bytes: Uint8Array; sig: Uint8Array; force: boolean }
  ): Promise<Response> {
    const relayMode = this.inRelayMode(userId);
    const plan = planKeyLogAppend({ relayMode, bytes: record.bytes });
    if (!plan.localFirst) {
      const blocked = this.refuseIfAttachedNotWriter();
      if (blocked) return blocked;
    }
    const compat = this.refuseUnsupportedHubAuthRecord(req, userId, record.bytes, record.sig);
    if (compat) return compat;
    const hubSync = this.usesHubSync(req);
    if (hubSync && !plan.localFirst) {
      return this.handleKeyLogHubSync(userId, record.bytes, record.sig, record.force);
    }
    return this.applyKeyLogLocally(userId, record, { hubSync, plan, relayMode });
  }

  /** 本地先落账（验签/链校验照旧），再尽力把记录推给上级；上级不可达不算失败。 */
  private async applyKeyLogLocally(
    userId: string,
    record: { bytes: Uint8Array; sig: Uint8Array },
    opts: { hubSync: boolean; plan: KeyLogAppendPlan; relayMode: boolean }
  ): Promise<Response> {
    const { bytes, sig } = record;
    const done = async (seq: number | bigint, hash: Uint8Array): Promise<Response> => {
      const relayMode = opts.relayMode || this.inRelayMode(userId);
      let relayDelivery: { relayAck: boolean; relayError?: string } | undefined;
      if (opts.plan.publish && (!relayMode || !this.deps.publisher.publishAndAck)) {
        try {
          await this.deps.publisher.publish(record);
        } catch {
          // 本地提交不依赖上级可达。
        }
      }
      if (relayMode) {
        const ack = opts.plan.publish
          ? await this.publishToRelay(record)
          : { ok: false as const, error: 'not_published' };
        relayDelivery = ack.ok ? { relayAck: true } : { relayAck: false, relayError: ack.error };
      }
      return this.keyLogSuccess(seq, hash, {
        hubSync: opts.hubSync,
        hubAck: opts.hubSync,
        localApply: opts.plan.localFirst,
        ...relayDelivery,
      });
    };
    const applied = await this.deps.keyLogService.apply(userId, { bytes, sig });
    if (!applied.ok) {
      const replayed = this.identicalAppliedRecord(userId, bytes, sig);
      if (replayed) {
        this.deps.onKeyLogEffects?.(userId, []);
        return done(replayed.seq, replayed.hash);
      }
      if (applied.error === 'fork') {
        return jsonError('KEY_LOG_FORK', 409);
      }
      return jsonError(applied.error, 400);
    }
    this.emitKeyLogEffects(userId, applied.effects);
    return done(applied.seq, applied.hash);
  }

  /**
   * `/api/auth/mode` 的 Hub 投影。中继上联时一律为空：切到中继不会清 `userStore` 的 hub meta，
   * 也不会清 `VIBETERM_HUB_URL`，照旧上报会让前端把上级地址当成本机入口。
   * 非 Hub 且既无 writer 又无 meta 时同样为空——`hubPublicUrl` 的 `http://127.0.0.1` 兜底
   * 只服务上联拨号，摆到界面上是个谁也打不开的地址。
   */
  resolveHub(): { nodeId: string | null; publicUrl: string | null } {
    if (this.relayUplink()) return { nodeId: null, publicUrl: null };
    const rows = this.authorizedHubRows();
    const writerId = pickWriterHub(rows);
    if (writerId) {
      const writer = this.deps.hubStore?.get(writerId);
      return {
        nodeId: writerId,
        publicUrl: writer?.publicUrl ?? usableHubUrl(this.deps.hubPublicUrl),
      };
    }
    const meta = this.deps.userStore.getHubMeta();
    if (this.deps.roles.hub) {
      return {
        nodeId: this.deps.nodeId,
        publicUrl: usableHubUrl(this.deps.hubPublicUrl) ?? meta?.publicUrl ?? null,
      };
    }
    if (!meta) return { nodeId: null, publicUrl: usableHubUrl(this.deps.hubPublicUrl) };
    return {
      nodeId: meta.nodeId ?? null,
      publicUrl: meta.publicUrl ?? usableHubUrl(this.deps.hubPublicUrl),
    };
  }

  /** 主账号的上联是不是中继。 */
  private relayUplink(): boolean {
    const user = findPrimaryUser(this.deps.userStore, this.deps.primaryUserId);
    return user ? this.inRelayMode(user.id) : false;
  }

  /** 上级是中继：已应用的密钥日志里有非空中继列表就算数（比 node_identity 早一步生效）。 */
  private inRelayMode(userId: string): boolean {
    try {
      return (this.deps.keyLogService.currentState(userId).relays?.relays.length ?? 0) > 0;
    } catch {
      return false;
    }
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
        return this.keyLogSuccess(replayed.seq, replayed.hash, { hubSync: true, hubAck: true });
      }
      if (applied.error === 'fork') {
        return jsonError('KEY_LOG_FORK', 409);
      }
      return jsonError(applied.error, 400);
    }
    this.emitKeyLogEffects(userId, applied.effects);
    return this.keyLogSuccess(applied.seq, applied.hash, { hubSync: true, hubAck: true });
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
      // 预演必须无副作用：计数器只在记录真正落库那一次推进（见 makeDeferredVerifyPasskeyAssertion），
      // 否则计数器会自增的认证器上，紧随其后的本地落账验签必然失败。
      const { verify: verifyPasskeyAssertion } = makeDeferredVerifyPasskeyAssertion(
        this.deps.userStore
      );
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

  private async publishToRelay(record: {
    bytes: Uint8Array;
    sig: Uint8Array;
  }): Promise<KeyLogHubAck> {
    const ack = await this.safePublishAndAck(record);
    if (ack.ok || (ack.error !== 'timeout' && ack.error !== 'SEQ_MISMATCH')) return ack;
    try {
      const seq = decodeKeyLogRecord(record.bytes).seq;
      const remote = await this.deps.publisher.queryKeyLogAt?.(seq);
      if (remote && bytesEqual(remote.bytes, record.bytes) && bytesEqual(remote.sig, record.sig)) {
        return { ok: true, seq };
      }
    } catch {
      return ack;
    }
    return ack;
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
    opts: {
      hubSync: boolean;
      hubAck?: boolean;
      hubError?: string;
      localApply?: boolean;
      relayAck?: boolean;
      relayError?: string;
    }
  ): Response {
    this.host.invalidateAuthModeCache();
    const base = {
      ok: true,
      seq,
      hash: encodeBase64url(hash),
      ...(opts.relayAck !== undefined ? { relayAck: opts.relayAck } : {}),
      ...(opts.relayError ? { relayError: opts.relayError } : {}),
    };
    if (!opts.hubSync) return jsonBody(base);
    return jsonBody({
      ...base,
      hubAck: opts.hubAck === true,
      ...(opts.hubError ? { hubError: opts.hubError } : {}),
      // 本地日志即权威；relayAck 单独表示中继确认，未确认记录由同步补推
      ...(opts.localApply ? { localApply: true } : {}),
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
      inspectHubAuthRecordCompat(this.deps.userStore, bytes, userId, {
        relayMode: this.inRelayMode(userId),
        localNodeId: this.deps.nodeId,
      }),
      readHeaderPair(req.headers, FORCE_KEYLOG_HEADER) === '1'
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

  private emitKeyLogEffects(userId: string, effects: KeyLogEffect[]): void {
    logAuthSessionRevokes(userId, effects);
    this.deps.onKeyLogEffects?.(userId, effects);
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
