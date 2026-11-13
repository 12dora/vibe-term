import {
  computeRecordHash,
  decodeKeyLogRecord,
  encodeBase64url,
  genesisHead,
} from '@vibeterm/shared/auth';
import {
  RELAY_KEYLOG_PAGE_DEFAULT_LIMIT,
  RELAY_KEYLOG_PAGE_MAX_LIMIT,
  RELAY_KEYLOG_SEQ_MISMATCH,
  type RelayCtlMessage,
  type RelayEnvelope,
  type RelayKeyLogEntry,
  type RelayKeyLogRecordWire,
  type RelayKeylogMember,
  openRelayKeyLogRecord,
  relaySeqFromWire,
  relaySeqToWire,
  sealRelayKeyLogRecord,
} from '@vibeterm/shared/relay';
import { stamp } from './mesh-log';
import { openRelayKeyLogPage } from './relay-key-log-page';
import { RelayKeyLogPrefix } from './relay-key-log-prefix';
import type { KeyLogApplier, MeshScheduler } from './types';

export const RELAY_KEYLOG_ACK_TIMEOUT_MS = 10_000;
/** 上传缺失记录时的分页大小；本地日志可能远长于一页。 */
export const RELAY_KEYLOG_PUSH_PAGE = 64;
/** 单次追平的分页上限，防止 seq 被伪造成天文数字时空转。 */
export const RELAY_KEYLOG_MAX_PAGES = 4096;

const RELAY_MEMBER_OPS: Record<string, RelayKeylogMember['op']> = {
  'admit-node': 'admit',
  'readmit-node': 'admit',
  'revoke-node': 'revoke',
  'rotate-root': 'rotate-root',
  'rotate-root-keep': 'rotate-root',
  'reset-root': 'rotate-root',
};

export type RelayKeyLogRecord = RelayKeyLogEntry;
type RelayApplyPageOutcome = { applied: number; skipped: number; maxSeq: bigint };
export type RelayKeyLogAck = { ok: boolean; seq?: bigint; error?: string; head?: bigint };

/**
 * admit-node / revoke-node / 根轮换记录额外附带明文，供中继重建准入注册表与跟上根公钥；
 * 其它类型不给（中继看不到 payload）。revoke 与根轮换只有 root 签名在中继侧才被采信。
 */
export function relayMemberFromRecord(record: RelayKeyLogRecord): RelayKeylogMember | undefined {
  let type: string;
  try {
    type = decodeKeyLogRecord(record.bytes).type;
  } catch {
    return undefined;
  }
  const op = RELAY_MEMBER_OPS[type];
  if (!op) return undefined;
  return { op, bytes: encodeBase64url(record.bytes), sig: encodeBase64url(record.sig) };
}

export type RelayKeyLogSyncHost = {
  generation(): number;
  isOnline(): boolean;
  isAuthenticated(): boolean;
  userId(): string;
  send(msg: RelayCtlMessage): void;
  logKey(): Promise<Uint8Array | null>;
  /** admit/revoke 记录要额外把明文记录交给中继建注册表。 */
  memberFor(record: RelayKeyLogRecord): RelayKeylogMember | undefined;
  onSynced?(): void;
  /** 诊断日志用；secondary 分叉时写入 `url=`。 */
  url?(): string;
};

/** `publish` = 主中继，可无条件补推；`prefix-verified` = secondary，只向已验证前缀补推。 */
export type RelayKeyLogPushMode = 'publish' | 'prefix-verified';

export type RelayKeyLogSyncOptions = {
  host: RelayKeyLogSyncHost;
  applier: KeyLogApplier;
  scheduler?: MeshScheduler;
  timeoutMs?: number;
  pushMode?: RelayKeyLogPushMode;
};

/** 中继密钥日志同步。`prefix-verified` 只向已验证前缀补推，主中继无条件发布。 */
export class RelayKeyLogSync {
  remoteHead: bigint | null = null;
  /** 拉下来但解不开 / 应用不了的记录数（诊断用，前端展示）。 */
  skipped = 0;
  /**
   * 第一条卡住的 seq：拉取时解不开 / 应用不了的中继记录，或本地超前时被中继拒收的本机记录。
   * 非 null 时不报 caughtUp；重连时清掉重试。
   */
  blockedSeq: bigint | null = null;
  /** 上一轮追平是否真的追平了（`onSynced` 只在追平时触发）。 */
  caughtUp = false;

  private readonly host: RelayKeyLogSyncHost;
  private readonly applier: KeyLogApplier;
  private readonly timeoutMs: number;
  private pushMode: RelayKeyLogPushMode;
  /** secondary 的前缀校验与分叉状态。 */
  private readonly prefix: RelayKeyLogPrefix;
  /** `blockedSeq` 来自补推被拒（而不是拉取卡住）：本地追到它也不能解除。 */
  private pushRefused = false;
  private readonly pendingAcks = new Map<string, (ack: RelayKeyLogAck) => void>();
  private pendingReq: {
    from: bigint;
    resolve: (rows: RelayKeyLogRecordWire[]) => void;
    reject: (err: Error) => void;
  } | null = null;
  private chain: Promise<void> = Promise.resolve();

  pendingOps = (): number => (this.pendingReq ? 1 : 0) + this.pendingAcks.size;

  constructor(opts: RelayKeyLogSyncOptions) {
    this.host = opts.host;
    this.applier = opts.applier;
    this.timeoutMs = opts.timeoutMs ?? RELAY_KEYLOG_ACK_TIMEOUT_MS;
    this.pushMode = opts.pushMode ?? 'publish';
    this.prefix = new RelayKeyLogPrefix({
      generation: () => this.host.generation(),
      applier: this.applier,
      readRemoteAt: (seq) => this.readKeyLogAt(seq),
      url: () => this.host.url?.() ?? '',
    });
  }

  /** secondary 发现远端日志不是本地前缀；仅本连接有效，重连后清掉。 */
  get diverged(): boolean {
    return this.prefix.diverged;
  }

  setPushMode(mode: RelayKeyLogPushMode): void {
    this.pushMode = mode;
    if (mode === 'publish') this.schedule();
  }

  reset(reason = 'reconnect'): void {
    this.remoteHead = null;
    // 重连后重试一次：卡住的原因可能是密钥还没到（`set-relays` / `meta-key` 迟到）
    this.blockedSeq = null;
    this.pushRefused = false;
    this.prefix.reset();
    this.caughtUp = false;
    const req = this.pendingReq;
    this.pendingReq = null;
    req?.reject(new Error(reason));
    const acks = [...this.pendingAcks.values()];
    this.pendingAcks.clear();
    for (const waiter of acks) waiter({ ok: false, error: 'offline' });
    this.chain = Promise.resolve();
  }

  noteRemoteHead(seq: bigint): void {
    this.remoteHead = seq;
    this.schedule();
  }

  handleRes(msg: Extract<RelayCtlMessage, { t: 'relay.keylog.res' }>): void {
    const pending = this.pendingReq;
    if (!pending) return;
    this.pendingReq = null;
    if (msg.records.length > RELAY_KEYLOG_PAGE_MAX_LIMIT) {
      pending.reject(new Error('relay-keylog-res-too-large'));
      return;
    }
    pending.resolve(msg.records);
  }

  handleAck(msg: Extract<RelayCtlMessage, { t: 'relay.keylog.ack' }>): void {
    const waiter = this.pendingAcks.get(msg.id);
    if (!waiter) return;
    this.pendingAcks.delete(msg.id);
    waiter({
      ok: msg.ok,
      ...(msg.seq !== undefined ? { seq: relaySeqFromWire(msg.seq) } : {}),
      ...(msg.error ? { error: msg.error } : {}),
      ...(msg.head !== undefined ? { head: relaySeqFromWire(msg.head) } : {}),
    });
  }

  handlePush(msg: Extract<RelayCtlMessage, { t: 'relay.keylog.push' }>): void {
    if (msg.records.length === 0) return;
    let highest = 0n;
    for (const row of msg.records) {
      const seq = relaySeqFromWire(row.seq);
      if (seq > highest) highest = seq;
    }
    const generation = this.host.generation();
    this.enqueue(async () => {
      const outcome = await this.applyPage(msg.records, generation);
      if (outcome.applied > 0) {
        if (this.remoteHead === null || highest > this.remoteHead) this.remoteHead = highest;
        await this.clearBlockedIfPassed();
        return;
      }
      this.noteRemoteHead(highest);
    });
  }

  async appendAndAck(
    record: RelayKeyLogRecord,
    timeoutMs = this.timeoutMs,
    generation?: number
  ): Promise<RelayKeyLogAck> {
    if (
      (generation !== undefined && generation !== this.host.generation()) ||
      !this.host.isOnline() ||
      !this.host.isAuthenticated()
    ) {
      return { ok: false, error: 'offline' };
    }
    const key = await this.host.logKey();
    if (!key) return { ok: false, error: 'relay_log_key_missing' };
    let seq: bigint;
    let blob: RelayEnvelope;
    try {
      seq = decodeKeyLogRecord(record.bytes).seq;
      blob = await sealRelayKeyLogRecord(key, record);
    } catch {
      return { ok: false, error: 'malformed_record' };
    }
    const id = crypto.randomUUID();
    const member = this.host.memberFor(record);
    return new Promise<RelayKeyLogAck>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);
      this.pendingAcks.set(id, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
      try {
        this.host.send({
          t: 'relay.keylog.append',
          id,
          seq: relaySeqToWire(seq),
          blob,
          ...(member ? { member } : {}),
        });
      } catch {
        this.pendingAcks.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: 'offline' });
      }
    });
  }

  async queryKeyLogAt(seq: bigint): Promise<RelayKeyLogRecord | null> {
    const generation = this.host.generation();
    const query = this.chain.then(() =>
      generation === this.host.generation() ? this.readKeyLogAt(seq) : null
    );
    this.chain = query.then(
      () => {},
      () => {}
    );
    return query;
  }

  async queryHead(): Promise<{ seq: bigint; hash: Uint8Array } | null> {
    if (!this.host.isOnline() || !this.host.isAuthenticated()) return null;
    const generation = this.host.generation();
    await this.chain;
    if (generation !== this.host.generation()) return null;
    const seq = this.remoteHead;
    if (seq === null) return null;
    if (seq === 0n) return genesisHead();
    const record = await this.queryKeyLogAt(seq);
    if (!record || generation !== this.host.generation()) return null;
    return { seq, hash: computeRecordHash(record.bytes, record.sig) };
  }

  private async readKeyLogAt(seq: bigint): Promise<RelayKeyLogRecord | null> {
    if (!this.host.isOnline() || !this.host.isAuthenticated() || this.pendingReq) return null;
    let rows: RelayKeyLogRecordWire[];
    try {
      rows = await this.request(seq, 1);
    } catch {
      return null;
    }
    const found = rows.find((row) => relaySeqFromWire(row.seq) === seq);
    if (!found) return null;
    const key = await this.host.logKey();
    if (!key) return null;
    try {
      const record = await openRelayKeyLogRecord(key, found.blob);
      return decodeKeyLogRecord(record.bytes).seq === seq ? record : null;
    } catch {
      return null;
    }
  }

  /** 立即拉一轮同步（`requestCatchUpNow` 的实现）。 */
  schedule(): void {
    const generation = this.host.generation();
    this.enqueue(() => this.runCatchUp(generation));
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain
      .then(() => (this.host.isAuthenticated() ? work() : undefined))
      .catch((err) => {
        console.warn(stamp(`[relay] key-log sync failed err=${errMessage(err)}`));
      });
  }

  private async runCatchUp(generation: number): Promise<void> {
    const remote = this.remoteHead;
    if (remote === null || generation !== this.host.generation()) return;
    const userId = this.host.userId();
    if (!userId) {
      console.warn(stamp('[relay] key-log catch-up skipped: empty userId'));
      return;
    }
    const localSeq = await this.pullBehind(generation, userId, remote);
    if (localSeq === null || generation !== this.host.generation()) return;
    await this.clearBlockedIfPassed();
    const target = this.remoteHead ?? remote;
    const pushed = await this.maybePushAhead(generation, userId, target, localSeq);
    if (pushed === null || generation !== this.host.generation()) return;
    this.finishCatchUp(pushed === (this.remoteHead ?? remote));
  }

  /** 本地落后且没卡在下一条时一页页拉；返回拉完后的本地 head，世代已变返回 null。 */
  private async pullBehind(
    generation: number,
    userId: string,
    remote: bigint
  ): Promise<bigint | null> {
    const local = await this.applier.head(userId);
    if (generation !== this.host.generation()) return null;
    if (local.seq >= remote || this.blockedSeq === local.seq + 1n) return local.seq;
    await this.pullPages(generation, userId, local.seq, remote);
    return (await this.applier.head(userId)).seq;
  }

  private finishCatchUp(pushedToHead: boolean): void {
    this.caughtUp = !this.prefix.diverged && this.blockedSeq === null && pushedToHead;
    // 只有真的两边一致才算同步完成：卡住的日志不该让上层以为一切正常
    if (this.caughtUp) this.host.onSynced?.();
  }

  private async clearBlockedIfPassed(): Promise<void> {
    if (this.blockedSeq === null || this.pushRefused) return;
    const userId = this.host.userId();
    if (!userId) return;
    if ((await this.applier.head(userId)).seq >= this.blockedSeq) this.blockedSeq = null;
  }

  /** 本地超前才补推；secondary 还要先确认远端是本地前缀（主中继是本机新记录的发布路径，无条件补推）。失败返回 null。 */
  private async maybePushAhead(
    generation: number,
    userId: string,
    remoteNow: bigint,
    localSeq: bigint
  ): Promise<bigint | null> {
    const verify = this.pushMode === 'prefix-verified' && localSeq >= remoteNow;
    if (verify && !(await this.prefix.verify(generation, userId, remoteNow, localSeq))) {
      this.caughtUp = false;
      return null;
    }
    if (localSeq <= remoteNow) return localSeq;
    await this.pushMissing(generation, userId, remoteNow);
    return (await this.applier.head(userId)).seq;
  }

  /**
   * 一页一页拉到追平为止。**解不开 / 验不过的记录不再卡死整条同步**：
   * 记一笔跳过并把游标推过这一页继续（本地 head 推不动——链是连续的——但至少不会永远重试同一页）。
   */
  private async pullPages(
    generation: number,
    userId: string,
    from: bigint,
    target: bigint
  ): Promise<void> {
    let cursor = from;
    let guard = 0;
    while (cursor < target && generation === this.host.generation()) {
      guard += 1;
      if (guard > RELAY_KEYLOG_MAX_PAGES) return;
      const rows = await this.request(cursor + 1n, RELAY_KEYLOG_PAGE_DEFAULT_LIMIT);
      if (rows.length === 0) return;
      const outcome = await this.applyPage(rows, generation);
      if (generation !== this.host.generation()) return;
      const head = await this.applier.head(userId);
      if (head.seq > cursor) {
        cursor = head.seq;
        continue;
      }
      if (outcome.skipped === 0) {
        console.warn(stamp('[relay] key-log catch-up stalled: head did not advance'));
        return;
      }
      if (this.blockedSeq === null) this.blockedSeq = cursor + 1n;
      console.warn(
        stamp(
          `[relay] key-log skipping unusable records from seq=${String(cursor + 1n)} skipped=${this.skipped}`
        )
      );
      cursor = outcome.maxSeq > cursor ? outcome.maxSeq : cursor + 1n;
    }
  }

  private async applyPage(
    rows: readonly RelayKeyLogRecordWire[],
    generation: number
  ): Promise<RelayApplyPageOutcome> {
    const idle: RelayApplyPageOutcome = { applied: 0, skipped: 0, maxSeq: 0n };
    const key = await this.host.logKey();
    if (!key || generation !== this.host.generation()) return idle;
    const { records, skipped, maxSeq } = await openRelayKeyLogPage(key, rows);
    this.skipped += skipped;
    if (records.length === 0) return { applied: 0, skipped, maxSeq };
    const result = await this.applier.applyMany(this.host.userId(), records);
    if (result.error) {
      console.warn(
        stamp(`[relay] key-log applyMany rejected err=${result.error} applied=${result.applied}`)
      );
      const rejected = records.length - result.applied;
      this.skipped += rejected;
      return { applied: result.applied, skipped: skipped + rejected, maxSeq };
    }
    return { applied: result.applied, skipped, maxSeq };
  }

  /** 分页上传：本地日志可能有几千条，一次性 list 出来会把整条链读进内存。 */
  private async pushMissing(generation: number, userId: string, remote: bigint): Promise<void> {
    let cursor = remote;
    for (let page = 0; page < RELAY_KEYLOG_MAX_PAGES; page += 1) {
      if (generation !== this.host.generation()) return;
      const rows =
        (await this.applier.list?.(userId, cursor + 1n, undefined, RELAY_KEYLOG_PUSH_PAGE)) ?? [];
      if (rows.length === 0) return;
      for (const row of rows) {
        if (generation !== this.host.generation()) return;
        if (row.seq <= cursor) continue;
        const ack = await this.appendAndAck(
          { bytes: row.bytes, sig: row.sig },
          this.timeoutMs,
          generation
        );
        if (!ack.ok) {
          this.noteRefusedPush(row.seq, ack);
          return;
        }
        cursor = row.seq;
        this.notePushAccepted(row.seq, ack);
      }
    }
  }

  private notePushAccepted(seq: bigint, ack: RelayKeyLogAck): void {
    if (ack.seq !== undefined) this.remoteHead = ack.seq;
    if (!this.pushRefused || this.blockedSeq === null || seq < this.blockedSeq) return;
    this.pushRefused = false;
    this.blockedSeq = null;
  }

  /**
   * 中继拒收本机记录：SEQ_MISMATCH 且中继 head 已不低于该 seq 是别的节点先推了，下一轮照常拉取；
   * 其余拒绝（未准入、日志满等）记 `blockedSeq`，不报 caughtUp。超时 / 离线不算拒绝。
   */
  private noteRefusedPush(seq: bigint, ack: RelayKeyLogAck): void {
    console.warn(stamp(`[relay] key-log append rejected err=${ack.error ?? 'unknown'}`));
    if (ack.head === undefined) return;
    this.remoteHead = ack.head;
    if (ack.error === RELAY_KEYLOG_SEQ_MISMATCH && ack.head >= seq) return;
    if (this.blockedSeq === null || seq < this.blockedSeq) this.blockedSeq = seq;
    this.pushRefused = true;
  }

  private request(from: bigint, limit: number): Promise<RelayKeyLogRecordWire[]> {
    if (!this.host.isAuthenticated()) return Promise.reject(new Error('relay-offline'));
    if (this.pendingReq) return Promise.reject(new Error('relay-keylog-pending'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingReq?.from === from) {
          this.pendingReq = null;
          reject(new Error('relay-keylog-timeout'));
        }
      }, this.timeoutMs);
      this.pendingReq = {
        from,
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
        this.host.send({
          t: 'relay.keylog.req',
          from_seq: relaySeqToWire(from),
          limit: Math.min(limit, RELAY_KEYLOG_PAGE_MAX_LIMIT),
        });
      } catch (err) {
        clearTimeout(timer);
        this.pendingReq = null;
        reject(err instanceof Error ? err : new Error('relay-keylog-send-failed'));
      }
    });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
