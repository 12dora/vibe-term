import { decodeBase64url, decodeKeyLogRecord, encodeBase64url } from '@tmex/shared/auth';
import {
  RELAY_KEYLOG_PAGE_DEFAULT_LIMIT,
  RELAY_KEYLOG_PAGE_MAX_LIMIT,
  type RelayCtlMessage,
  type RelayEnvelope,
  type RelayKeyLogRecordWire,
  type RelayKeylogMember,
  openEnvelope,
  relaySeqFromWire,
  relaySeqToWire,
  sealEnvelope,
} from '@tmex/shared/relay';
import { stamp } from './mesh-log';
import type { KeyLogApplier, MeshScheduler } from './types';

export const RELAY_KEYLOG_ENVELOPE_KIND = 'keylog';
export const RELAY_KEYLOG_PLAINTEXT_MAX_BYTES = 256 * 1024;
export const RELAY_KEYLOG_ACK_TIMEOUT_MS = 10_000;

export type RelayKeyLogRecord = { bytes: Uint8Array; sig: Uint8Array };
export type RelayKeyLogAck = { ok: boolean; seq?: bigint; error?: string; head?: bigint };

/**
 * 中继密钥日志块的明文帧：`{bytes, sig}` 的 b64url JSON（与 hub `key.log.res` 同形状）。
 * passkey 签名是变长 Borsh 断言，拼接形态无法切分，所以不用 plan 1.4 字面写的 `bytes ‖ sig`。
 * 与 `packages/app/src/lib/relay-keylog.ts` 逐字节一致，两侧解得开对方的块。
 */
export function encodeRelayKeyLogPlaintext(record: RelayKeyLogRecord): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      bytes: encodeBase64url(record.bytes),
      sig: encodeBase64url(record.sig),
    })
  );
}

export function decodeRelayKeyLogPlaintext(plaintext: Uint8Array): RelayKeyLogRecord {
  if (plaintext.byteLength > RELAY_KEYLOG_PLAINTEXT_MAX_BYTES) {
    throw new Error('relay key log record too large');
  }
  let parsed: { bytes?: unknown; sig?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext)) as typeof parsed;
  } catch {
    throw new Error('relay key log record is not valid JSON');
  }
  if (typeof parsed.bytes !== 'string' || typeof parsed.sig !== 'string') {
    throw new Error('relay key log record missing bytes/sig');
  }
  return { bytes: decodeBase64url(parsed.bytes), sig: decodeBase64url(parsed.sig) };
}

export async function sealRelayKeyLogRecord(
  logKey: Uint8Array,
  record: RelayKeyLogRecord
): Promise<RelayEnvelope> {
  return sealEnvelope(logKey, RELAY_KEYLOG_ENVELOPE_KIND, encodeRelayKeyLogPlaintext(record));
}

export async function openRelayKeyLogRecord(
  logKey: Uint8Array,
  envelope: RelayEnvelope
): Promise<RelayKeyLogRecord> {
  return decodeRelayKeyLogPlaintext(
    await openEnvelope(logKey, RELAY_KEYLOG_ENVELOPE_KIND, envelope)
  );
}

/**
 * admit-node / revoke-node 记录额外附带明文，供中继重建准入注册表；
 * 其它类型不给（中继看不到 payload）。revoke 只有 root 签名在中继侧才被采信。
 */
export function relayMemberFromRecord(record: RelayKeyLogRecord): RelayKeylogMember | undefined {
  let type: string;
  try {
    type = decodeKeyLogRecord(record.bytes).type;
  } catch {
    return undefined;
  }
  const op = type === 'admit-node' ? 'admit' : type === 'revoke-node' ? 'revoke' : null;
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
};

export type RelayKeyLogSyncOptions = {
  host: RelayKeyLogSyncHost;
  applier: KeyLogApplier;
  scheduler?: MeshScheduler;
  timeoutMs?: number;
};

/**
 * 中继侧密钥日志双向同步：本地 head 落后就拉取解密应用，超前就上传缺失记录。
 * 与 hub 版本的区别是中继只有 seq、没有链哈希，因此不做 fork 判定（由本地 applier 兜底）。
 */
export class RelayKeyLogSync {
  remoteHead: bigint | null = null;

  private readonly host: RelayKeyLogSyncHost;
  private readonly applier: KeyLogApplier;
  private readonly timeoutMs: number;
  private readonly pendingAcks = new Map<string, (ack: RelayKeyLogAck) => void>();
  private pendingReq: {
    from: bigint;
    resolve: (rows: RelayKeyLogRecordWire[]) => void;
    reject: (err: Error) => void;
  } | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: RelayKeyLogSyncOptions) {
    this.host = opts.host;
    this.applier = opts.applier;
    this.timeoutMs = opts.timeoutMs ?? RELAY_KEYLOG_ACK_TIMEOUT_MS;
  }

  reset(reason = 'reconnect'): void {
    this.remoteHead = null;
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
      const applied = await this.applyPage(msg.records, generation);
      if (!applied) this.noteRemoteHead(highest);
      else if (this.remoteHead === null || highest > this.remoteHead) this.remoteHead = highest;
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
      return await openRelayKeyLogRecord(key, found.blob);
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
    let local = await this.applier.head(userId);
    if (generation !== this.host.generation()) return;
    if (local.seq < remote) {
      await this.pullPages(generation, userId, local.seq, remote);
      local = await this.applier.head(userId);
    }
    if (generation !== this.host.generation()) return;
    if (local.seq > remote) await this.pushMissing(generation, userId, remote);
    this.host.onSynced?.();
  }

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
      if (guard > 256) return;
      const rows = await this.request(cursor + 1n, RELAY_KEYLOG_PAGE_DEFAULT_LIMIT);
      if (rows.length === 0) return;
      const applied = await this.applyPage(rows, generation);
      if (!applied) return;
      const head = await this.applier.head(userId);
      if (head.seq <= cursor) {
        console.warn(stamp('[relay] key-log catch-up stalled: head did not advance'));
        return;
      }
      cursor = head.seq;
    }
  }

  private async applyPage(
    rows: readonly RelayKeyLogRecordWire[],
    generation: number
  ): Promise<boolean> {
    const key = await this.host.logKey();
    if (!key || generation !== this.host.generation()) return false;
    const sorted = [...rows].sort((a, b) => {
      const as = relaySeqFromWire(a.seq);
      const bs = relaySeqFromWire(b.seq);
      return as < bs ? -1 : as > bs ? 1 : 0;
    });
    const records: RelayKeyLogRecord[] = [];
    for (const row of sorted) {
      try {
        records.push(await openRelayKeyLogRecord(key, row.blob));
      } catch {
        console.warn(stamp(`[relay] key-log blob undecryptable seq=${String(row.seq)}`));
        return false;
      }
    }
    if (records.length === 0) return false;
    const result = await this.applier.applyMany(this.host.userId(), records);
    if (result.error) {
      console.warn(
        stamp(`[relay] key-log applyMany rejected err=${result.error} applied=${result.applied}`)
      );
      return result.applied > 0;
    }
    return true;
  }

  private async pushMissing(generation: number, userId: string, remote: bigint): Promise<void> {
    const rows = (await this.applier.list?.(userId, remote + 1n)) ?? [];
    for (const row of rows) {
      if (generation !== this.host.generation()) return;
      if (row.seq <= remote) continue;
      const ack = await this.appendAndAck(
        { bytes: row.bytes, sig: row.sig },
        this.timeoutMs,
        generation
      );
      if (!ack.ok) {
        if (ack.head !== undefined) this.remoteHead = ack.head;
        console.warn(stamp(`[relay] key-log append rejected err=${ack.error ?? 'unknown'}`));
        return;
      }
      if (ack.seq !== undefined) this.remoteHead = ack.seq;
    }
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
