import { type KeyLogEffect, encodeBase64url } from '@vibeterm/shared/auth';
import { FORCE_KEYLOG_HEADER, readHeaderPair } from '@vibeterm/shared/http/mesh-headers';
import { HUB_NOT_WRITER } from '@vibeterm/shared/uplink';
import { pickWriterHub } from '../auth/mesh-hub-store';
import {
  applyForcedKeyLogCompat,
  filterNotRetiredHubRecords,
  inspectHubAuthRecordCompat,
} from '../hub/hub-authorization';
import { isLoopbackHostLiteral } from './address-class';
import { logAuthSessionRevokes } from './auth-audit-log';
import { type KeyLogAppendPlan, planKeyLogAppend, readKeyLogAppend } from './auth-key-log-plan';
import { AuthKeyLogSync } from './auth-key-log-sync';
import { findPrimaryUser } from './auth-mode-cache';
import type { AuthRoutesDeps } from './auth-routes';
import { exemptMetaKeyLaggingNodes, metaKeyLaggingIdsFor } from './relay-meta-lag';
import { jsonBody, jsonError } from './session-middleware';
import { sameHubUrl } from './uplink-pool';

export type { LoginFailureSink } from './auth-key-log-login';
export { createLoginFailureSink, loginRequestContext } from './auth-key-log-login';
export { verifySecondFactors } from './auth-passkey-origin';
export { definesUplink, planKeyLogAppend } from './auth-key-log-plan';
export type { KeyLogAppendPlan } from './auth-key-log-plan';

export type AuthKeyLogHost = {
  invalidateAuthModeCache: () => void;
  getForwardWriterWrite: () => ((req: Request, uid?: string) => Promise<Response | null>) | null;
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

export class AuthKeyLogRoutes {
  private readonly sync: AuthKeyLogSync;

  constructor(
    private readonly deps: AuthRoutesDeps,
    private readonly host: AuthKeyLogHost
  ) {
    this.sync = new AuthKeyLogSync(deps);
  }

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
          ? await this.sync.publishToRelay(record)
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
      const replayed = this.sync.identicalAppliedRecord(userId, bytes, sig);
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
    const preview = await this.sync.previewKeyLog(userId, bytes, sig);
    if (!preview.ok) {
      if (preview.error === 'fork') {
        return jsonError('KEY_LOG_FORK', 409);
      }
      return jsonError(preview.error, 400);
    }
    const ack = await this.sync.syncToHub({ bytes, sig, force });
    if (!ack.ok) {
      if (ack.error === 'HUB_TIMEOUT') {
        return jsonError('HUB_TIMEOUT', 504);
      }
      return jsonError(ack.error, 409);
    }
    const applied = await this.deps.keyLogService.apply(userId, { bytes, sig });
    if (!applied.ok) {
      const replayed = this.sync.identicalAppliedRecord(userId, bytes, sig);
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
    if (this.sync.identicalAppliedRecord(userId, bytes, sig)) {
      return null;
    }
    const relayMode = this.inRelayMode(userId);
    const compat = exemptMetaKeyLaggingNodes(
      applyForcedKeyLogCompat(
        inspectHubAuthRecordCompat(this.deps.userStore, bytes, userId, {
          relayMode,
          localNodeId: this.deps.nodeId,
        }),
        readHeaderPair(req.headers, FORCE_KEYLOG_HEADER) === '1'
      ),
      bytes,
      relayMode ? () => this.metaKeyLaggingIds(userId) : null
    );
    if (compat.ok) return null;
    return jsonError(compat.code, 409, {
      minVersion: compat.minVersion,
      nodes: compat.nodes,
    });
  }

  private metaKeyLaggingIds(userId: string): ReadonlySet<string> {
    return metaKeyLaggingIdsFor({
      stateOf: () => this.deps.keyLogService.currentState(userId),
      certs: () => this.deps.userStore.listCertsByUser(userId),
      selfNodeId: this.deps.nodeId,
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
