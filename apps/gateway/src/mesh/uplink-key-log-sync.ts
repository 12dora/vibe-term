import { bytesEqual } from '@tmex/shared/auth';
import { backoffDelayMs } from './ctl';
import type { KeyLogApplier, KeyLogForkEvent, MeshScheduler } from './types';
import {
  KEY_LOG_PAGE_DEFAULT_LIMIT,
  KEY_LOG_PAGE_MAX_LIMIT,
  type UplinkCtlMessage,
  type UplinkKeyLogAck,
  type UplinkKeyLogRecord,
  type UplinkNodeList,
  encodeUplinkCtl,
} from './uplink-protocol';

export type KeyLogHead = { seq: bigint; hash: Uint8Array };

export type UplinkKeyLogSyncHost = {
  generation(): number;
  isAuthenticated(): boolean;
  userId(): string;
  isOnline(): boolean;
  send(bytes: Uint8Array): void;
  tearDown(reason: string): void;
  persistList(list: UplinkNodeList): void;
  emitNodeList(list: UplinkNodeList): void;
};

export type CatchUpSnapshot = {
  appliers: Promise<unknown>[];
  tasks: Promise<unknown>[];
};

type CatchUpCtx = {
  generation: number;
  epoch: number;
  userId: string;
  signal: AbortSignal;
};

type SyncOpts = {
  host: UplinkKeyLogSyncHost;
  applier: KeyLogApplier;
  scheduler: MeshScheduler;
  timeoutMs: number;
  retryLimit: number;
  onFork?: (event: KeyLogForkEvent) => void;
  warnCatchUp?: (err: unknown) => void;
};

export class UplinkKeyLogSync {
  lastKeyLogHead: KeyLogHead | null = null;

  private readonly host: UplinkKeyLogSyncHost;
  private readonly applier: KeyLogApplier;
  private readonly scheduler: MeshScheduler;
  private readonly timeoutMs: number;
  private readonly retryLimit: number;
  private readonly onFork?: (event: KeyLogForkEvent) => void;
  private readonly warnCatchUp?: (err: unknown) => void;
  private catchUpChain: Promise<void> = Promise.resolve();
  private catchUpAbort: AbortController | null = null;
  private readonly catchUpTasks = new Map<number, Set<Promise<unknown>>>();
  private readonly applierTasks = new Map<number, Set<Promise<unknown>>>();
  private readonly catchUpCancels = new Set<() => void>();
  private pendingKeyLog: {
    id: string;
    resolve: (records: UplinkKeyLogRecord[]) => void;
    reject: (err: Error) => void;
  } | null = null;
  private listEpoch = 0;
  private listVersionWatermark = Number.NEGATIVE_INFINITY;
  private latestList: UplinkNodeList | null = null;
  private keyLogResMissingIdWarned = false;
  private readonly pendingAcks = new Map<string, (ack: UplinkKeyLogAck) => void>();
  private keyLogForked = false;
  private hubNotWriterLogged = false;
  private skipPushForGeneration: number | null = null;

  constructor(opts: SyncOpts) {
    this.host = opts.host;
    this.applier = opts.applier;
    this.scheduler = opts.scheduler;
    this.timeoutMs = opts.timeoutMs;
    this.retryLimit = opts.retryLimit;
    this.onFork = opts.onFork;
    this.warnCatchUp = opts.warnCatchUp;
  }

  get pendingKeyLogId(): string | undefined {
    return this.pendingKeyLog?.id;
  }

  snapshotTasks(generation: number): CatchUpSnapshot {
    return {
      appliers: [...(this.applierTasks.get(generation) ?? [])],
      tasks: [...(this.catchUpTasks.get(generation) ?? [])],
    };
  }

  async awaitSnapshot(snapshot: CatchUpSnapshot): Promise<void> {
    if (snapshot.appliers.length > 0) {
      await Promise.race([
        Promise.allSettled(snapshot.appliers),
        this.scheduler.sleep(this.timeoutMs),
      ]);
    }
    if (snapshot.tasks.length > 0) {
      await Promise.allSettled(snapshot.tasks);
    }
  }

  reset(reason = 'reconnect'): void {
    this.catchUpAbort?.abort();
    const cancels = [...this.catchUpCancels];
    this.catchUpCancels.clear();
    for (const cancel of cancels) cancel();
    const pending = this.pendingKeyLog;
    this.pendingKeyLog = null;
    pending?.reject(new Error(reason));
    const acks = [...this.pendingAcks.entries()];
    this.pendingAcks.clear();
    for (const [id, waiter] of acks) {
      waiter({ t: 'key.log.ack', id, ok: false, error: 'offline' });
    }
    this.latestList = null;
    this.catchUpChain = Promise.resolve();
    this.listVersionWatermark = Number.NEGATIVE_INFINITY;
    this.keyLogResMissingIdWarned = false;
    this.hubNotWriterLogged = false;
    this.skipPushForGeneration = null;
    this.catchUpAbort = new AbortController();
  }

  handleKeyLogRes(msg: Extract<UplinkCtlMessage, { t: 'key.log.res' }>): void {
    const pending = this.pendingKeyLog;
    if (!pending) return;
    if (msg.id !== pending.id) {
      if (!msg.id && !this.keyLogResMissingIdWarned) {
        this.keyLogResMissingIdWarned = true;
        console.warn('[uplink] key.log.res dropped: missing id');
      }
      return;
    }
    this.pendingKeyLog = null;
    if (msg.error === 'rate_limited') {
      const hint = msg.retry_after_ms != null ? ` retry_after_ms=${msg.retry_after_ms}` : '';
      pending.reject(new Error(`rate_limited${hint}`));
      return;
    }
    if (msg.records.length > KEY_LOG_PAGE_MAX_LIMIT) {
      pending.reject(new Error('key-log-res-too-large'));
      return;
    }
    pending.resolve(msg.records);
  }

  handleKeyLogAck(msg: UplinkKeyLogAck): void {
    const waiter = this.pendingAcks.get(msg.id);
    this.pendingAcks.delete(msg.id);
    waiter?.(msg);
  }

  ingestNodeList(list: UplinkNodeList): void {
    if (list.version < this.listVersionWatermark) return;
    this.listVersionWatermark = list.version;
    this.lastKeyLogHead = list.key_log_head;
    this.latestList = list;
    const generation = this.host.generation();
    const epoch = ++this.listEpoch;
    this.host.persistList(list);
    const userId = this.host.userId();
    this.catchUpChain = this.catchUpChain
      .then(() => {
        if (generation !== this.host.generation()) return;
        const work = this.catchUpFromList(list, epoch, generation, userId);
        return this.trackTask(this.catchUpTasks, generation, work);
      })
      .catch((err) => {
        this.warnCatchUp?.(err);
      });
  }

  private finishNodeList(epoch: number, generation: number): void {
    if (epoch !== this.listEpoch || generation !== this.host.generation()) return;
    const list = this.latestList;
    if (!list) return;
    this.host.emitNodeList(list);
  }

  private catchUpAliveCtx(ctx: CatchUpCtx): boolean {
    return (
      !ctx.signal.aborted &&
      ctx.generation === this.host.generation() &&
      this.host.isAuthenticated() &&
      !this.keyLogForked &&
      ctx.userId === this.host.userId()
    );
  }

  private catchUpCurrent(ctx: CatchUpCtx): boolean {
    return this.catchUpAliveCtx(ctx) && ctx.epoch === this.listEpoch;
  }

  private trackTask<T>(
    map: Map<number, Set<Promise<unknown>>>,
    generation: number,
    work: Promise<T>
  ): Promise<T> {
    const set = map.get(generation) ?? new Set<Promise<unknown>>();
    map.set(generation, set);
    set.add(work);
    return work.finally(() => {
      set.delete(work);
      if (set.size === 0) map.delete(generation);
    });
  }

  private async awaitCatchUp<T>(ctx: CatchUpCtx, work: Promise<T>): Promise<T> {
    if (ctx.signal.aborted) {
      throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('aborted');
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.catchUpCancels.delete(cancel);
        ctx.signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(value as T);
      };
      const cancel = () => finish(new Error('aborted'));
      const onAbort = () =>
        finish(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('aborted'));
      const timer = setTimeout(() => finish(new Error('applier-timeout')), this.timeoutMs);
      this.catchUpCancels.add(cancel);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => finish(undefined, value),
        (err) => finish(err instanceof Error ? err : new Error(String(err)))
      );
    });
  }

  private async catchUpFromList(
    list: UplinkNodeList,
    epoch: number,
    generation: number,
    userId: string
  ): Promise<void> {
    const ctx: CatchUpCtx = {
      generation,
      epoch,
      userId,
      signal: this.catchUpAbort?.signal ?? AbortSignal.abort(),
    };
    try {
      await this.runCatchUpFromList(list, ctx);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message === 'aborted' || err.message === 'applier-timeout')
      ) {
        return;
      }
      throw err;
    }
  }

  private awaitHead(ctx: CatchUpCtx): Promise<KeyLogHead> {
    return this.awaitCatchUp(
      ctx,
      this.trackTask(this.applierTasks, ctx.generation, this.applier.head(ctx.userId, ctx.signal))
    );
  }

  private async runCatchUpFromList(list: UplinkNodeList, ctx: CatchUpCtx): Promise<void> {
    if (!this.catchUpCurrent(ctx)) return;
    if (!ctx.userId) {
      console.warn('[uplink] key-log catch-up skipped: empty userId');
      this.finishNodeList(ctx.epoch, ctx.generation);
      return;
    }
    const target = list.key_log_head;
    const local = await this.readCatchUpHead(ctx);
    if (!local || !this.catchUpCurrent(ctx)) return;
    if (local.seq !== target.seq) {
      console.warn(
        `[uplink] key-log catch-up start local=${local.seq.toString()} target=${target.seq.toString()}`
      );
    }
    if (local.seq === target.seq) {
      if (!bytesEqual(local.hash, target.hash)) this.failFork(local, target);
      else this.finishNodeList(ctx.epoch, ctx.generation);
      return;
    }
    if (local.seq > target.seq) {
      if (await this.pushMissingRecords(ctx, target.seq))
        this.finishNodeList(ctx.epoch, ctx.generation);
      return;
    }
    await this.pullAndApplyPages(ctx, local, target);
  }

  private async readCatchUpHead(ctx: CatchUpCtx): Promise<KeyLogHead | null> {
    let retries = 0;
    while (this.catchUpCurrent(ctx)) {
      try {
        const local = await this.awaitHead(ctx);
        return this.catchUpCurrent(ctx) ? local : null;
      } catch (err) {
        if (!this.catchUpCurrent(ctx)) return null;
        retries += 1;
        console.warn(`[uplink] key-log head failed err=${errMsg(err)} retry=${retries}`);
        if (!(await this.retryOrTearDown(retries, 'key-log-head-failed', ctx.signal))) return null;
      }
    }
    return null;
  }

  private async pushMissingRecords(ctx: CatchUpCtx, hubSeq: bigint): Promise<boolean> {
    let retries = 0;
    while (this.catchUpCurrent(ctx)) {
      let pushed = false;
      try {
        pushed = await this.pushMissingToHub(ctx, hubSeq);
      } catch (err) {
        if (!this.catchUpCurrent(ctx)) return false;
        retries += 1;
        console.warn(`[uplink] key-log list/push failed err=${errMsg(err)} retry=${retries}`);
        if (!(await this.retryOrTearDown(retries, 'key-log-push-failed', ctx.signal))) return false;
        continue;
      }
      if (!this.catchUpCurrent(ctx)) return false;
      if (pushed) return true;
      retries += 1;
      if (!(await this.retryOrTearDown(retries, 'key-log-push-failed', ctx.signal))) return false;
    }
    return false;
  }

  private async pullAndApplyPages(
    ctx: CatchUpCtx,
    start: KeyLogHead,
    target: KeyLogHead
  ): Promise<void> {
    const retries = { n: 0 };
    let local = start;
    while (this.catchUpCurrent(ctx) && local.seq < target.seq) {
      const before = local;
      let records: UplinkKeyLogRecord[];
      try {
        records = await this.requestKeyLog(before.seq + 1n);
      } catch (err) {
        if (!this.catchUpCurrent(ctx)) return;
        retries.n += 1;
        console.warn(
          `[uplink] key-log catch-up request failed local=${before.seq.toString()} err=${errMsg(err)} retry=${retries.n}`
        );
        if (!(await this.retryOrTearDown(retries.n, 'key-log-catch-up-failed', ctx.signal))) return;
        continue;
      }
      if (!this.catchUpAliveCtx(ctx)) return;
      if (records.length === 0) {
        if (ctx.epoch !== this.listEpoch) return;
        retries.n += 1;
        console.warn(
          `[uplink] key-log catch-up empty res local=${before.seq.toString()} target=${target.seq.toString()} retry=${retries.n}`
        );
        if (!(await this.retryOrTearDown(retries.n, 'key-log-catch-up-failed', ctx.signal))) return;
        continue;
      }
      const sorted = [...records].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
      if (sorted[0] && sorted[0].seq !== before.seq + 1n) {
        console.warn(
          `[uplink] key-log catch-up seq gap want=${(before.seq + 1n).toString()} got=${sorted[0].seq.toString()}`
        );
        this.host.tearDown('key-log-seq-gap');
        return;
      }
      const next = await this.applyCatchUpPage(ctx, before, sorted, target, retries);
      if (!next) {
        if (!this.catchUpCurrent(ctx)) return;
        continue;
      }
      local = next.local;
      if (next.reset) retries.n = 0;
    }
    this.verifyCatchUpTarget(ctx, local, target);
  }

  private async applyCatchUpPage(
    ctx: CatchUpCtx,
    before: KeyLogHead,
    records: UplinkKeyLogRecord[],
    target: KeyLogHead,
    retries: { n: number }
  ): Promise<{ local: KeyLogHead; reset: boolean } | undefined> {
    let result: { applied: number; error?: string };
    try {
      result = await this.awaitCatchUp(
        ctx,
        this.trackTask(
          this.applierTasks,
          ctx.generation,
          this.applier.applyMany(
            ctx.userId,
            records.map((row) => ({ bytes: row.bytes, sig: row.sig })),
            ctx.signal
          )
        )
      );
    } catch (err) {
      if (!this.catchUpCurrent(ctx)) return;
      retries.n += 1;
      console.warn(`[uplink] key-log applyMany threw err=${errMsg(err)} retry=${retries.n}`);
      if (!(await this.retryOrTearDown(retries.n, 'key-log-apply-failed', ctx.signal))) return;
      return;
    }
    if (!this.catchUpAliveCtx(ctx)) return;
    let local: KeyLogHead;
    try {
      local = await this.awaitHead(ctx);
    } catch (err) {
      if (!this.catchUpCurrent(ctx)) return;
      retries.n += 1;
      console.warn(`[uplink] key-log head failed err=${errMsg(err)} retry=${retries.n}`);
      if (!(await this.retryOrTearDown(retries.n, 'key-log-head-failed', ctx.signal))) return;
      return;
    }
    if (!this.catchUpAliveCtx(ctx)) return;
    if (result.error === 'fork') {
      this.failFork(local, target);
      return;
    }
    if (ctx.epoch !== this.listEpoch) return;
    if (result.error) {
      console.warn(
        `[uplink] key-log applyMany rejected: ${result.error} applied=${result.applied}`
      );
      retries.n += 1;
      if (!(await this.retryOrTearDown(retries.n, 'key-log-apply-failed', ctx.signal))) return;
      return { local, reset: false };
    }
    if (local.seq === before.seq) {
      console.warn('[uplink] key-log catch-up stalled: head did not advance');
      retries.n += 1;
      if (!(await this.retryOrTearDown(retries.n, 'key-log-stalled', ctx.signal))) return;
      return;
    }
    return { local, reset: true };
  }

  private verifyCatchUpTarget(ctx: CatchUpCtx, local: KeyLogHead, target: KeyLogHead): void {
    if (!this.catchUpCurrent(ctx)) return;
    if (local.seq === target.seq && !bytesEqual(local.hash, target.hash)) {
      this.failFork(local, target);
      return;
    }
    if (local.seq < target.seq) {
      console.warn(
        `[uplink] key-log catch-up incomplete local=${local.seq.toString()} target=${target.seq.toString()}`
      );
      this.host.tearDown('key-log-catch-up-incomplete');
      return;
    }
    console.warn(
      `[uplink] key-log catch-up result local=${local.seq.toString()} target=${target.seq.toString()}`
    );
    this.finishNodeList(ctx.epoch, ctx.generation);
  }

  private async retryOrTearDown(
    retries: number,
    reason: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    if (retries > this.retryLimit) {
      this.host.tearDown(reason);
      return false;
    }
    try {
      await this.scheduler.sleep(backoffDelayMs(retries - 1, 200, 2_000), signal);
      return !signal?.aborted;
    } catch {
      return false;
    }
  }

  async queryHubHead(): Promise<{ seq: bigint; hash: Uint8Array } | null> {
    return this.lastKeyLogHead;
  }

  async queryKeyLogAt(
    seq: bigint,
    timeoutMs = this.timeoutMs
  ): Promise<{ bytes: Uint8Array; sig: Uint8Array } | null> {
    if (!this.host.isOnline() || this.pendingKeyLog || !this.host.isAuthenticated()) {
      return null;
    }
    let records: UplinkKeyLogRecord[];
    try {
      records = await this.requestKeyLog(seq, timeoutMs);
    } catch {
      return null;
    }
    const found = records.find((row) => row.seq === seq);
    return found ? { bytes: found.bytes, sig: found.sig } : null;
  }

  async appendAndAck(
    record: { bytes: Uint8Array; sig: Uint8Array },
    timeoutMs = this.timeoutMs,
    generation?: number
  ): Promise<UplinkKeyLogAck> {
    if (
      (generation !== undefined && generation !== this.host.generation()) ||
      !this.host.isOnline() ||
      !this.host.isAuthenticated()
    ) {
      return { t: 'key.log.ack', id: '', ok: false, error: 'offline' };
    }
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        resolve({ t: 'key.log.ack', id, ok: false, error: 'timeout' });
      }, timeoutMs);
      this.pendingAcks.set(id, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
      try {
        this.host.send(
          encodeUplinkCtl({
            t: 'key.log.append',
            bytes: record.bytes,
            sig: record.sig,
            id,
          })
        );
      } catch {
        this.pendingAcks.delete(id);
        clearTimeout(timer);
        resolve({ t: 'key.log.ack', id, ok: false, error: 'offline' });
      }
    });
  }

  private async pushMissingToHub(ctx: CatchUpCtx, hubSeq: bigint): Promise<boolean> {
    if (!this.catchUpCurrent(ctx)) return false;
    if (this.skipPushForGeneration === ctx.generation) return true;
    const listed = await this.awaitCatchUp(
      ctx,
      this.trackTask(
        this.applierTasks,
        ctx.generation,
        this.applier.list?.(ctx.userId, hubSeq + 1n, ctx.signal) ?? Promise.resolve([])
      )
    );
    if (!this.catchUpCurrent(ctx)) return false;
    if (!listed || listed.length === 0) return false;
    const sorted = [...listed].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    for (const row of sorted) {
      if (!this.catchUpCurrent(ctx)) return false;
      if (row.seq <= hubSeq) continue;
      const ack = await this.appendAndAck(
        { bytes: row.bytes, sig: row.sig },
        this.timeoutMs,
        ctx.generation
      );
      if (!this.catchUpCurrent(ctx)) return false;
      if (!ack.ok) {
        if (ack.error === 'HUB_NOT_WRITER') {
          this.skipPushForGeneration = ctx.generation;
          if (!this.hubNotWriterLogged) {
            this.hubNotWriterLogged = true;
            console.warn(
              '[uplink] key-log append deferred: attached hub is not writer; will retry after hub change'
            );
          }
          return true;
        }
        return false;
      }
    }
    return true;
  }

  private requestKeyLog(
    fromSeq: bigint,
    timeoutMs = this.timeoutMs
  ): Promise<UplinkKeyLogRecord[]> {
    if (!this.host.isAuthenticated()) {
      return Promise.reject(new Error('uplink-offline'));
    }
    if (this.pendingKeyLog) {
      return Promise.reject(new Error('key-log-pending'));
    }
    const id = crypto.randomUUID();
    console.warn(`[uplink] key.log.req from_seq=${fromSeq.toString()} id=${id}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingKeyLog?.id === id) {
          this.pendingKeyLog = null;
          reject(new Error('key-log-timeout'));
        }
      }, timeoutMs);
      this.pendingKeyLog = {
        id,
        resolve: (rows) => {
          clearTimeout(timer);
          resolve(rows);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      try {
        this.host.send(
          encodeUplinkCtl({
            t: 'key.log.req',
            from_seq: fromSeq,
            id,
            limit: KEY_LOG_PAGE_DEFAULT_LIMIT,
          })
        );
      } catch (err) {
        clearTimeout(timer);
        this.pendingKeyLog = null;
        reject(err instanceof Error ? err : new Error('key-log-send-failed'));
      }
    });
  }

  private failFork(local: KeyLogHead, remote: KeyLogHead): void {
    this.keyLogForked = true;
    this.onFork?.({ userId: this.host.userId(), local, remote });
    this.host.tearDown('key_log_fork');
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
