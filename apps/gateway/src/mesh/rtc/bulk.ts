import { BULK_FRAME_BYTES, BULK_MAX_FRAME_BYTES, iterateFrames } from '@vibeterm/transfer';
import type { FilesBulkHooks } from '../../api/files';
import { DC_HIGH_WATER_BYTES, DC_LOW_WATER_BYTES } from './data-channel-carrier';
import type { DataChannelLike } from './native';
import { copyBytes, sendBinary, toUint8Array } from './native';

export const BULK_CHANNEL_PREFIX = 'bulk:';
/** 两个方向统一 16 KiB；接收侧仍放宽到 64 KiB 兼容老版本浏览器端。 */
export const BULK_FRAME_SIZE = BULK_FRAME_BYTES;
export const BULK_MAX_RECEIVED_FRAME_SIZE = BULK_MAX_FRAME_BYTES;
export const BULK_IDLE_TIMEOUT_MS = 30_000;
export const BULK_CONTROL_MAX_BYTES = 4096;
export const BULK_UPLOAD_QUEUE_BUDGET_BYTES = 8 * 1024 * 1024;

export type BulkState = 'idle' | 'put' | 'get' | 'done' | 'eof' | 'aborted';

export type BulkAttachContext = {
  uid: string;
  ownerKey?: string;
  verify?: () => boolean;
};

export type BulkTransferServiceOptions = {
  files: FilesBulkHooks;
  now?: () => number;
  idleTimeoutMs?: number;
  uploadQueueBudgetBytes?: number;
};

type BulkControl = {
  op: string;
  transferId?: unknown;
  size?: unknown;
};

type BulkChannel = {
  dc: DataChannelLike;
  uid: string;
  ownerKey: string;
  verify: (() => boolean) | null;
  labelId: string;
  transferId: string | null;
  state: BulkState;
  received: number;
  expectedSize: number;
  lastActivity: number;
  timer: ReturnType<typeof setTimeout> | null;
  drainWaiters: Array<() => void>;
  cancelDownload: (() => void) | null;
  io: Promise<void>;
  queuedBytes: number;
};

export function parseBulkChannelLabel(label: string | undefined | null): string | null {
  if (!label || !label.startsWith(BULK_CHANNEL_PREFIX)) return null;
  const id = label.slice(BULK_CHANNEL_PREFIX.length);
  return id.length > 0 ? id : null;
}

function sendJson(dc: DataChannelLike, value: unknown): void {
  if (!dc.isOpen()) return;
  try {
    dc.sendMessage(JSON.stringify(value));
  } catch {
    // channel gone
  }
}

function parseControl(msg: string | Buffer | ArrayBuffer): BulkControl | null {
  if (typeof msg === 'string') return parseControlText(msg);
  const bytes = toUint8Array(msg);
  if (bytes.byteLength === 0 || bytes.byteLength > BULK_CONTROL_MAX_BYTES) return null;
  if (bytes[0] !== 0x7b) return null;
  return parseControlText(new TextDecoder().decode(bytes));
}

function parseControlText(text: string): BulkControl | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object') return null;
    const op = (value as { op?: unknown }).op;
    if (typeof op !== 'string') return null;
    return value as BulkControl;
  } catch {
    return null;
  }
}

function maxMessageSize(dc: DataChannelLike): number {
  try {
    const n = dc.maxMessageSize();
    return n > 0 ? n : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export class BulkTransferService {
  private readonly files: FilesBulkHooks;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly uploadQueueBudgetBytes: number;
  private readonly channels = new Set<BulkChannel>();

  constructor(opts: BulkTransferServiceOptions) {
    this.files = opts.files;
    this.now = opts.now ?? Date.now;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? BULK_IDLE_TIMEOUT_MS;
    this.uploadQueueBudgetBytes = opts.uploadQueueBudgetBytes ?? BULK_UPLOAD_QUEUE_BUDGET_BYTES;
  }

  attachChannel(dc: DataChannelLike, ctx: BulkAttachContext): void {
    const labelId = parseBulkChannelLabel(dc.getLabel?.());
    if (!labelId) return;

    const ch: BulkChannel = {
      dc,
      uid: ctx.uid,
      ownerKey: ctx.ownerKey ?? ctx.uid,
      verify: ctx.verify ?? null,
      labelId,
      transferId: labelId,
      state: 'idle',
      received: 0,
      expectedSize: 0,
      lastActivity: this.now(),
      timer: null,
      drainWaiters: [],
      cancelDownload: null,
      io: Promise.resolve(),
      queuedBytes: 0,
    };
    this.channels.add(ch);
    dc.setBufferedAmountLowThreshold(DC_LOW_WATER_BYTES);
    dc.onBufferedAmountLow(() => this.flushDrain(ch));
    dc.onMessage((msg) => this.onMessage(ch, msg));
    dc.onClosed(() => this.onClosed(ch));
    this.armIdle(ch);
  }

  close(): void {
    for (const ch of [...this.channels]) {
      this.finalize(ch, { code: 'aborted', cleanup: ch.state === 'put' || ch.state === 'get' });
    }
  }

  abortByOwner(ownerKey: string): void {
    for (const ch of [...this.channels]) {
      if (ch.ownerKey === ownerKey) {
        this.finalize(ch, { code: 'aborted', cleanup: ch.state === 'put' || ch.state === 'get' });
      }
    }
  }

  private onMessage(ch: BulkChannel, msg: string | Buffer | ArrayBuffer): void {
    if (ch.state === 'aborted' || ch.state === 'done' || ch.state === 'eof') return;
    if (ch.verify && !ch.verify()) {
      this.fail(ch, 'forbidden', { cleanup: ch.state === 'put' || ch.state === 'get' });
      return;
    }
    this.armIdle(ch);

    const bytes = typeof msg === 'string' ? new TextEncoder().encode(msg) : toUint8Array(msg);
    const control = parseControl(msg);
    if (control) {
      this.onControl(ch, control);
      return;
    }
    if (
      bytes.byteLength > maxMessageSize(ch.dc) ||
      bytes.byteLength > BULK_MAX_RECEIVED_FRAME_SIZE
    ) {
      this.fail(ch, 'too_large', { cleanup: ch.state === 'put' || ch.state === 'get' });
      return;
    }
    if (ch.state !== 'put') {
      this.fail(ch, 'protocol', { cleanup: false });
      return;
    }
    const copy = copyBytes(bytes);
    if (ch.queuedBytes + copy.byteLength > this.uploadQueueBudgetBytes) {
      this.fail(ch, 'backpressure', { cleanup: true });
      return;
    }
    ch.queuedBytes += copy.byteLength;
    this.enqueue(ch, async () => {
      try {
        await this.writePut(ch, copy);
      } finally {
        ch.queuedBytes -= copy.byteLength;
      }
    });
  }

  private enqueue(ch: BulkChannel, op: () => Promise<void>): void {
    ch.io = ch.io.then(op, op);
  }

  private onControl(ch: BulkChannel, control: BulkControl): void {
    if (control.op === 'abort') {
      this.fail(ch, 'aborted', { cleanup: ch.state === 'put' || ch.state === 'get' });
      return;
    }
    if (ch.state === 'idle' && control.op === 'put') {
      this.startPut(ch, control);
      return;
    }
    if (ch.state === 'idle' && control.op === 'get') {
      this.startGet(ch);
      return;
    }
    if (ch.state === 'put' && control.op === 'done') {
      this.enqueue(ch, async () => this.finishPut(ch));
      return;
    }
    this.fail(ch, 'protocol', { cleanup: ch.state === 'put' || ch.state === 'get' });
  }

  private startPut(ch: BulkChannel, control: BulkControl): void {
    const transferId = typeof control.transferId === 'string' ? control.transferId : '';
    const size =
      typeof control.size === 'number' && Number.isSafeInteger(control.size) && control.size >= 0
        ? control.size
        : -1;
    if (!transferId || size < 0 || transferId !== ch.labelId) {
      this.fail(ch, 'invalid', { cleanup: false });
      return;
    }
    const owner = this.files.status(transferId);
    if (!owner) {
      this.fail(ch, 'not_found', { cleanup: false });
      return;
    }
    if (owner.uid !== ch.uid) {
      this.fail(ch, 'permission_denied', { cleanup: false });
      return;
    }
    if (owner.kind === 'download') {
      this.fail(ch, 'invalid', { cleanup: false });
      return;
    }
    if (owner.expectedSize !== size) {
      this.fail(ch, 'invalid', { cleanup: false });
      return;
    }
    ch.transferId = transferId;
    ch.expectedSize = size;
    ch.received = 0;
    ch.state = 'put';
  }

  private async writePut(ch: BulkChannel, bytes: Uint8Array): Promise<void> {
    if (ch.state !== 'put') return;
    const transferId = ch.transferId;
    if (!transferId) {
      this.fail(ch, 'protocol', { cleanup: false });
      return;
    }
    if (ch.received + bytes.byteLength > ch.expectedSize) {
      this.fail(ch, 'too_large', { cleanup: true });
      return;
    }
    try {
      const res = await this.files.writeRange(transferId, ch.received, bytes);
      if (ch.state !== 'put') return;
      if (!res.ok) {
        this.fail(ch, res.code, { cleanup: true });
        return;
      }
      ch.received = res.received;
      this.armIdle(ch);
    } catch {
      if (ch.state === 'put') this.fail(ch, 'unknown', { cleanup: true });
    }
  }

  private finishPut(ch: BulkChannel): void {
    if (ch.state !== 'put') return;
    if (ch.received !== ch.expectedSize) {
      this.fail(ch, 'invalid', { cleanup: true });
      return;
    }
    ch.state = 'done';
    this.clearIdle(ch);
    sendJson(ch.dc, { ok: true });
  }

  private startGet(ch: BulkChannel): void {
    const transferId = ch.labelId;
    const owner = this.files.status(transferId);
    if (!owner) {
      this.fail(ch, 'not_found', { cleanup: false });
      return;
    }
    if (owner.uid !== ch.uid) {
      this.fail(ch, 'permission_denied', { cleanup: false });
      return;
    }
    if (owner.kind === 'upload') {
      this.fail(ch, 'invalid', { cleanup: false });
      return;
    }
    const stream = this.files.openRange(transferId);
    if (!stream) {
      this.fail(ch, 'not_found', { cleanup: false });
      return;
    }
    ch.transferId = transferId;
    ch.expectedSize = owner.expectedSize;
    ch.state = 'get';
    void this.pumpDownload(ch, stream);
  }

  private async pumpDownload(ch: BulkChannel, stream: ReadableStream<Uint8Array>): Promise<void> {
    const frames = iterateFrames(stream, BULK_FRAME_SIZE, {
      onCancel: (cancel) => {
        ch.cancelDownload = cancel;
      },
    });
    try {
      for await (const frame of frames) {
        await this.waitDrain(ch);
        if (ch.state !== 'get' || !ch.dc.isOpen()) return;
        this.armIdle(ch);
        if (!(await this.sendFrame(ch, frame))) return;
      }
      if (ch.state === 'get' && ch.dc.isOpen()) {
        if (!this.ensureVerified(ch)) return;
        ch.state = 'eof';
        this.clearIdle(ch);
        sendJson(ch.dc, { op: 'eof' });
      }
    } catch {
      if (ch.state === 'get') this.fail(ch, 'unknown', { cleanup: true });
    } finally {
      ch.cancelDownload = null;
    }
  }

  private ensureVerified(ch: BulkChannel): boolean {
    if (!ch.verify) return true;
    if (ch.verify()) return true;
    this.fail(ch, 'forbidden', { cleanup: ch.state === 'put' || ch.state === 'get' });
    return false;
  }

  private async sendFrame(ch: BulkChannel, bytes: Uint8Array): Promise<boolean> {
    await this.waitDrain(ch);
    if (ch.state !== 'get' || !ch.dc.isOpen()) return false;
    if (!this.ensureVerified(ch)) return false;
    if (sendBinary(ch.dc, bytes)) return true;
    if (!ch.dc.isOpen()) return false;
    await this.waitDrain(ch);
    if (ch.state !== 'get' || !ch.dc.isOpen()) return false;
    if (!this.ensureVerified(ch)) return false;
    return sendBinary(ch.dc, bytes);
  }

  private waitDrain(ch: BulkChannel): Promise<void> {
    if (!ch.dc.isOpen() || ch.dc.bufferedAmount() <= DC_HIGH_WATER_BYTES) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      ch.drainWaiters.push(resolve);
    });
  }

  private flushDrain(ch: BulkChannel): void {
    const waiters = ch.drainWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private onClosed(ch: BulkChannel): void {
    this.flushDrain(ch);
    if (ch.state === 'put' || ch.state === 'get') {
      this.finalize(ch, { code: 'aborted', cleanup: true });
      return;
    }
    this.finalize(ch, { code: 'aborted', cleanup: false });
  }

  private fail(ch: BulkChannel, code: string, opts: { cleanup: boolean }): void {
    if (ch.state === 'aborted' || ch.state === 'done' || ch.state === 'eof') return;
    sendJson(ch.dc, { ok: false, code });
    this.finalize(ch, { code, cleanup: opts.cleanup });
  }

  private finalize(ch: BulkChannel, opts: { code: string; cleanup: boolean }): void {
    const wasActive = ch.state === 'put' || ch.state === 'get' || ch.state === 'idle';
    if (!wasActive && ch.state !== 'aborted') {
      this.clearIdle(ch);
      this.channels.delete(ch);
      return;
    }
    if (ch.state === 'aborted') {
      this.clearIdle(ch);
      this.channels.delete(ch);
      return;
    }
    ch.state = 'aborted';
    this.clearIdle(ch);
    const cancel = ch.cancelDownload;
    ch.cancelDownload = null;
    try {
      cancel?.();
    } catch {
      // already cancelled
    }
    if (opts.cleanup && ch.transferId) {
      try {
        this.files.abort(ch.transferId);
      } catch {
        // best-effort
      }
    }
    this.flushDrain(ch);
    this.channels.delete(ch);
  }

  private armIdle(ch: BulkChannel): void {
    this.clearIdle(ch);
    if (ch.state === 'done' || ch.state === 'eof' || ch.state === 'aborted') return;
    ch.lastActivity = this.now();
    const timer = setTimeout(() => {
      if (ch.state === 'done' || ch.state === 'eof' || ch.state === 'aborted') return;
      this.fail(ch, 'timeout', { cleanup: ch.state === 'put' || ch.state === 'get' });
    }, this.idleTimeoutMs);
    timer.unref?.();
    ch.timer = timer;
  }

  private clearIdle(ch: BulkChannel): void {
    if (!ch.timer) return;
    clearTimeout(ch.timer);
    ch.timer = null;
  }
}
