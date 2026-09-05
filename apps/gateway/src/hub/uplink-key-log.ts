import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  computeRecordHash,
  decodeKeyLogRecord,
  nodeIdToHex,
} from '@tmex/shared/auth';
import type { LinkSession } from '@tmex/shared/link';
import { HUB_NOT_WRITER, type HubNotWriterError } from '@tmex/shared/uplink';
import { decodeB64url } from '../../../../packages/shared/src/auth/b64url';
import { identicalKeyLog } from '../../../../packages/shared/src/auth/key-log';
import type { UserStore } from '../auth/user-store';
import { applyForcedKeyLogCompat, inspectHubAuthRecordCompat } from './hub-authorization';
import { trimKeyLogPageToByteLimit } from './key-log-page';
import type { NodeRegistry } from './node-registry';
import type { HubKeyLogAppendSuccess, HubKeyLogSource } from './types';
import {
  KEY_LOG_PAGE_DEFAULT_LIMIT,
  KEY_LOG_PAGE_MAX_LIMIT,
  type UplinkCtlMessage,
  seqToWire,
} from './uplink-protocol';
import type { LiveConnection, UplinkServerState } from './uplink-server-state';

export const HUB_KEY_LOG_REQ_LOG_INTERVAL_MS = 10_000;

export type UplinkKeyLogDeps = {
  hubNodeId: () => string | undefined;
  isWriter: () => boolean;
  notWriterError: () => HubNotWriterError;
  send: (link: LinkSession, msg: UplinkCtlMessage) => void;
  broadcastNodeList: (userId: string) => Promise<'sent' | 'unchanged' | 'failed'>;
  certIsRevoked: (nodeId: string) => boolean;
  evictRevokedNode: (nodeId: string) => void;
  applyHubAuthorizationRecord: (
    userId: string,
    record: { type: string; payload: Uint8Array }
  ) => void;
};

export type UplinkKeyLogOptions = {
  state: UplinkServerState;
  userStore: UserStore;
  registry: NodeRegistry;
  keyLogSource: HubKeyLogSource;
  now: () => number;
  forwardAppend?: (record: { bytes: Uint8Array; sig: Uint8Array; force?: boolean }) => Promise<{
    ok: boolean;
    seq?: bigint | number;
    error?: string;
  } | null>;
  onForwardedWrite?: () => void;
  deps: UplinkKeyLogDeps;
};

/** key.log.req / key.log.append 的处理与追加副作用应用。 */
export class UplinkKeyLog {
  private readonly state: UplinkServerState;
  private readonly userStore: UserStore;
  private readonly registry: NodeRegistry;
  private readonly keyLogSource: HubKeyLogSource;
  private readonly now: () => number;
  private readonly forwardAppend?: UplinkKeyLogOptions['forwardAppend'];
  private readonly onForwardedWrite?: () => void;
  private readonly deps: UplinkKeyLogDeps;

  constructor(opts: UplinkKeyLogOptions) {
    this.state = opts.state;
    this.userStore = opts.userStore;
    this.registry = opts.registry;
    this.keyLogSource = opts.keyLogSource;
    this.now = opts.now;
    this.forwardAppend = opts.forwardAppend;
    this.onForwardedWrite = opts.onForwardedWrite;
    this.deps = opts.deps;
  }

  async handleKeyLogReq(
    live: LiveConnection,
    msg: Extract<UplinkCtlMessage, { t: 'key.log.req' }>
  ): Promise<void> {
    const now = this.now();
    const fromSeq = BigInt(msg.from_seq);
    if (!this.state.keyLogReqLimiter.take(live.nodeId, live.userId, now)) {
      this.warnKeyLogReq(live.nodeId, fromSeq, 0, true);
      this.deps.send(live.link, {
        t: 'key.log.res',
        records: [],
        error: 'rate_limited',
        retry_after_ms: this.state.keyLogReqLimiter.retryAfterMs,
        ...(msg.id ? { id: msg.id } : {}),
      });
      return;
    }
    const requested = msg.limit ?? KEY_LOG_PAGE_DEFAULT_LIMIT;
    const limit = Math.min(KEY_LOG_PAGE_MAX_LIMIT, Math.max(1, requested));
    const fetched = await this.keyLogSource.list(live.userId, fromSeq, limit + 1);
    const hasMore = fetched.length > limit;
    const page = hasMore ? fetched.slice(0, limit) : fetched;
    const trimmed = trimKeyLogPageToByteLimit(page, hasMore, msg.id ? { id: msg.id } : undefined);
    this.warnKeyLogReq(live.nodeId, fromSeq, trimmed.records.length, false);
    this.deps.send(live.link, {
      t: 'key.log.res',
      records: trimmed.records,
      has_more: trimmed.hasMore,
      ...(msg.id ? { id: msg.id } : {}),
    });
  }

  private warnKeyLogReq(nodeId: string, fromSeq: bigint, records: number, limited: boolean): void {
    const now = this.now();
    const prev = this.state.keyLogReqLogs.get(nodeId, now);
    if (prev && now - prev.lastAt < HUB_KEY_LOG_REQ_LOG_INTERVAL_MS) {
      prev.suppressed += 1;
      return;
    }
    const suppressed = prev?.suppressed ?? 0;
    const extra = [suppressed > 0 ? `suppressed=${suppressed}` : '', limited ? 'limited=1' : '']
      .filter(Boolean)
      .join(' ');
    console.warn(
      `[hub] key.log.req node=${nodeId} from_seq=${fromSeq.toString()} records=${records}${extra ? ` ${extra}` : ''}`
    );
    this.state.keyLogReqLogs.set(nodeId, { lastAt: now, suppressed: 0 }, now);
  }

  async handleKeyLogAppend(
    live: LiveConnection,
    bytesB64: string,
    sigB64: string,
    id?: string,
    force = false
  ): Promise<void> {
    let bytes: Uint8Array;
    let sig: Uint8Array;
    try {
      bytes = decodeB64url(bytesB64);
      sig = decodeB64url(sigB64, 64);
    } catch {
      live.link.close('protocol_error');
      return;
    }
    if (!this.deps.isWriter()) {
      const replayed = await this.identicalListed(live.userId, bytes, sig);
      if (replayed) {
        if (id) {
          this.deps.send(live.link, {
            t: 'key.log.ack',
            id,
            ok: true,
            seq: seqToWire(replayed.seq),
          });
        }
        const replayedOk = this.replayedAppendSuccess(bytes, sig, replayed.seq);
        await this.runAppendEffects(live.userId, replayedOk);
        return;
      }
      const forwarded = this.forwardAppend ? await this.forwardAppend({ bytes, sig, force }) : null;
      if (forwarded) {
        if (id) {
          if (forwarded.ok) {
            this.deps.send(live.link, {
              t: 'key.log.ack',
              id,
              ok: true,
              seq: seqToWire(forwarded.seq ?? 0),
            });
          } else {
            this.deps.send(live.link, {
              t: 'key.log.ack',
              id,
              ok: false,
              error: forwarded.error ?? 'error',
            });
          }
        }
        if (forwarded.ok) this.onForwardedWrite?.();
        return;
      }
      if (id) {
        const err = this.deps.notWriterError();
        this.deps.send(live.link, {
          t: 'key.log.ack',
          id,
          ok: false,
          error: HUB_NOT_WRITER,
          writerHubId: err.writerHubId,
          writerPublicUrl: err.writerPublicUrl,
          writerEpoch: err.writerEpoch,
        } as UplinkCtlMessage);
      }
      return;
    }
    const already = await this.identicalListed(live.userId, bytes, sig);
    if (already) {
      if (id) {
        this.deps.send(live.link, { t: 'key.log.ack', id, ok: true, seq: seqToWire(already.seq) });
      }
      await this.runAppendEffects(live.userId, this.replayedAppendSuccess(bytes, sig, already.seq));
      return;
    }
    const compat = applyForcedKeyLogCompat(
      inspectHubAuthRecordCompat(this.userStore, bytes, live.userId, {
        localNodeId: this.deps.hubNodeId(),
      }),
      force
    );
    if (!compat.ok) {
      if (id) {
        this.deps.send(live.link, {
          t: 'key.log.ack',
          id,
          ok: false,
          error: KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
        });
      }
      return;
    }
    const result = await this.keyLogSource.append(live.userId, { bytes, sig });
    if (result.ok) {
      if (id) {
        this.deps.send(live.link, { t: 'key.log.ack', id, ok: true, seq: seqToWire(result.seq) });
      }
      await this.runAppendEffects(live.userId, result);
      return;
    }
    const replayed = await this.identicalListed(live.userId, bytes, sig);
    if (replayed) {
      if (id) {
        this.deps.send(live.link, { t: 'key.log.ack', id, ok: true, seq: seqToWire(replayed.seq) });
      }
      await this.runAppendEffects(
        live.userId,
        this.replayedAppendSuccess(bytes, sig, replayed.seq)
      );
      return;
    }
    if (id) {
      this.deps.send(live.link, { t: 'key.log.ack', id, ok: false, error: result.error });
    }
  }

  private identicalListed(userId: string, bytes: Uint8Array, sig: Uint8Array) {
    return identicalKeyLog((seq) => this.keyLogSource.list(userId, seq), bytes, sig);
  }

  private replayedAppendSuccess(
    bytes: Uint8Array,
    sig: Uint8Array,
    seq: bigint
  ): HubKeyLogAppendSuccess {
    const record = decodeKeyLogRecord(bytes);
    return {
      ok: true,
      seq,
      hash: computeRecordHash(bytes, sig),
      effects: [],
      record: { type: record.type, payload: record.payload },
    };
  }

  private async runAppendEffects(userId: string, result: HubKeyLogAppendSuccess): Promise<void> {
    try {
      await this.applyAppendEffects(userId, result);
    } catch {
      // effects are retried on identical-record replay
    }
  }

  async applyAppendEffects(userId: string, result: HubKeyLogAppendSuccess): Promise<void> {
    if (
      result.record.type === 'rotate-root' ||
      result.record.type === 'reset-root' ||
      result.record.type === 'rotate-root-keep'
    ) {
      this.userStore.invalidateUnusedEnrollmentTokens(userId, this.now());
    }
    if (
      result.record.type === 'admit-hub' ||
      result.record.type === 'retire-hub' ||
      result.record.type === 'revoke-node'
    ) {
      this.deps.applyHubAuthorizationRecord(userId, result.record);
    }
    for (const effect of result.effects) {
      if (effect.type === 'revokeSessionsVia') {
        this.deps.evictRevokedNode(nodeIdToHex(effect.nodeId));
      }
    }
    for (const entry of this.registry.listForBroadcast(userId)) {
      if (this.deps.certIsRevoked(entry.nodeId)) {
        this.deps.evictRevokedNode(entry.nodeId);
      }
    }
    await this.deps.broadcastNodeList(userId);
  }
}
