import { type KeyLogEffect, encodeBase64url } from '@vibeterm/shared/auth';
import { logAuthSessionRevokes } from './auth-audit-log';
import { type KeyLogAppendPlan, planKeyLogAppend, readKeyLogAppend } from './auth-key-log-plan';
import { AuthKeyLogSync } from './auth-key-log-sync';
import type { AuthRoutesDeps } from './auth-routes';
import { inspectKeyLogRecordCompat } from './key-log-compat';
import { exemptMetaKeyLaggingNodes, metaKeyLaggingIdsFor } from './relay-meta-lag';
import { jsonBody, jsonError } from './session-middleware';

export type { LoginFailureSink } from './auth-key-log-login';
export { createLoginFailureSink, loginRequestContext } from './auth-key-log-login';
export { verifySecondFactors } from './auth-passkey-origin';
export { definesUplink, planKeyLogAppend } from './auth-key-log-plan';
export type { KeyLogAppendPlan } from './auth-key-log-plan';

export type AuthKeyLogHost = {
  invalidateAuthModeCache: () => void;
};

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
    const record = await readKeyLogAppend(req);
    if (!record) return jsonError('MALFORMED', 400);
    return this.appendKeyLog(req, userId, record);
  }

  private async appendKeyLog(
    req: Request,
    userId: string,
    record: { bytes: Uint8Array; sig: Uint8Array }
  ): Promise<Response> {
    const relayMode = this.inRelayMode(userId);
    const plan = planKeyLogAppend({ relayMode, bytes: record.bytes });
    const compat = this.refuseUnsupportedKeyLogRecord(req, userId, record.bytes, record.sig);
    if (compat) return compat;
    const hubSync = this.usesHubSync(req);
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

  /** 上级是中继：已应用的密钥日志里有非空中继列表就算数（比 node_identity 早一步生效）。 */
  private inRelayMode(userId: string): boolean {
    try {
      return (this.deps.keyLogService.currentState(userId).relays?.relays.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * `?hub=sync` 是冻结别名：本地落账后再尽力推给中继。任意 `roles.node` 都走这条语义；
   * 成功响应仍带 `hubAck: true`（= 本地已应用）。
   */
  private usesHubSync(req: Request): boolean {
    if (new URL(req.url).searchParams.get('hub') === 'sync') return true;
    return Boolean(this.deps.roles.node);
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

  private refuseUnsupportedKeyLogRecord(
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
      inspectKeyLogRecordCompat(this.deps.userStore, bytes, userId, {
        relayMode,
        localNodeId: this.deps.nodeId,
      }),
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

  private emitKeyLogEffects(userId: string, effects: KeyLogEffect[]): void {
    logAuthSessionRevokes(userId, effects);
    this.deps.onKeyLogEffects?.(userId, effects);
  }
}

function seqToJson(seq: bigint | number): number | string {
  const value = typeof seq === 'bigint' ? seq : BigInt(seq);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
