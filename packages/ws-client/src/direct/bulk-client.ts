// 浏览器侧 bulk 文件通道客户端（设计 §3「DataChannel 消息尺寸与背压 / bulk 协议」）。
//
// 在已鉴权的直连 `RTCPeerConnection` 上按 transfer 开一条 `bulk:<transferId>` 通道，
// 与 node 侧 `apps/gateway/src/mesh/rtc/bulk.ts` 一一对应：
//
//   上传：`{op:'put', transferId, size}` → 整条 64 KiB 二进制消息（末条可短，无分片头）
//         → `{op:'done'}` → node 回 `{ok:true}` 或 `{ok:false, code}`
//   下载：`{op:'get'}` → 64 KiB 二进制帧 → `{op:'eof'}`（失败时 `{ok:false, code}`）
//   任一方向异常：`{op:'abort'}`
//
// 控制帧一律走文本消息（node 侧 `sendMessage(JSON.stringify(...))`），数据帧走二进制，
// 因此下载方向的二进制**恒为文件内容**，不做 node 侧那套「小且以 `{` 开头」的启发式判定。
//
// 注意：本通道**不经过 `DirectDataChannelCarrier`**——不分片、不走 Borsh envelope，
// 背压自己按 4 MiB 高水位 / 1 MiB 低水位处理。

import {
  DC_HIGH_WATER_BYTES,
  DC_LOW_WATER_BYTES,
  type RTCDataChannelLike,
} from './data-channel-carrier';

export const BULK_CHANNEL_PREFIX = 'bulk:';
export const BULK_FRAME_SIZE = 64 * 1024;
export const DEFAULT_BULK_OPEN_TIMEOUT_MS = 15_000;

export type BulkResult = { ok: true } | { ok: false; code: string };

/** 传输层失败（通道打不开 / 中途关闭 / 越界）；node 的 `{ok:false}` 不走这里，而是正常 resolve。 */
export class BulkTransferError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? code);
    this.name = 'BulkTransferError';
  }
}

/** `BulkClient` 只需要直连控制器的这两个能力。 */
export interface BulkChannelSource {
  /** `'active'` 时才允许开 bulk 通道。 */
  getState(): string;
  /** 在已鉴权的 PC 上开一条新通道（label 由 `BulkClient` 生成）。 */
  createDataChannel(label: string, init?: { ordered?: boolean }): RTCDataChannelLike;
}

export interface BulkUploadRequest {
  transferId: string;
  /** 必须与 REST `init` 登记的字节数完全一致，否则 node 回 `{ok:false, code:'invalid'}`。 */
  size: number;
  source: Blob | ReadableStream<Uint8Array>;
  signal?: AbortSignal;
  onProgress?: (sent: number, total: number) => void;
}

export interface BulkDownloadRequest {
  transferId: string;
  signal?: AbortSignal;
  onProgress?: (received: number) => void;
}

export interface BulkClientOptions {
  frameSize?: number;
  highWaterBytes?: number;
  lowWaterBytes?: number;
  openTimeoutMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export function bulkChannelLabel(transferId: string): string {
  return `${BULK_CHANNEL_PREFIX}${transferId}`;
}

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

function parseControlJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isBlobLike(source: Blob | ReadableStream<Uint8Array>): source is Blob {
  const candidate = source as Partial<Blob>;
  return typeof candidate.slice === 'function' && typeof candidate.arrayBuffer === 'function';
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/** 把任意来源切成恰好 `frameSize` 的帧（末帧可短）。 */
export async function* iterateBulkFrames(
  source: Blob | ReadableStream<Uint8Array>,
  frameSize: number
): AsyncGenerator<Uint8Array> {
  if (isBlobLike(source)) {
    const total = source.size;
    for (let offset = 0; offset < total; offset += frameSize) {
      const slice = source.slice(offset, Math.min(offset + frameSize, total));
      yield new Uint8Array(await slice.arrayBuffer());
    }
    return;
  }
  const reader = source.getReader();
  let pending: Uint8Array = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      pending = concatBytes(pending, value);
      while (pending.byteLength >= frameSize) {
        yield pending.subarray(0, frameSize).slice();
        pending = pending.subarray(frameSize).slice();
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  if (pending.byteLength > 0) yield pending;
}

/** 单条 bulk 通道的收发外壳：open 等待、控制/数据分流、背压排水。 */
class BulkChannelSession {
  onControl: ((value: Record<string, unknown>) => void) | null = null;
  onData: ((bytes: Uint8Array) => void) | null = null;
  onClosed: (() => void) | null = null;

  private readonly drainWaiters: Array<() => void> = [];
  private readonly openWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private closed = false;
  private opened = false;

  constructor(
    readonly channel: RTCDataChannelLike,
    private readonly highWater: number,
    lowWater: number,
    /** 下载方向的二进制是文件内容；上传方向的入站消息全是控制帧。 */
    private readonly binaryIsData: boolean,
    private readonly schedule: (fn: () => void, ms: number) => unknown,
    private readonly cancelTimer: (handle: unknown) => void
  ) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = lowWater;
    channel.onmessage = (event) => this.dispatch(event.data);
    channel.onbufferedamountlow = () => this.flushDrain();
    channel.onopen = () => this.markOpen();
    channel.onclose = () => this.markClosed();
    channel.onerror = () => this.markClosed();
    if (channel.readyState === 'open') this.opened = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  ready(timeoutMs: number): Promise<void> {
    if (this.opened) return Promise.resolve();
    if (this.closed) return Promise.reject(new BulkTransferError('closed', 'bulk channel closed'));
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          this.cancelTimer(handle);
          resolve();
        },
        reject: (err: Error) => {
          this.cancelTimer(handle);
          reject(err);
        },
      };
      const handle = this.schedule(() => {
        const idx = this.openWaiters.indexOf(waiter);
        if (idx >= 0) this.openWaiters.splice(idx, 1);
        reject(new BulkTransferError('timeout', 'bulk channel open timeout'));
      }, timeoutMs);
      this.openWaiters.push(waiter);
    });
  }

  sendControl(value: Record<string, unknown>): void {
    if (this.closed || this.channel.readyState !== 'open') return;
    try {
      this.channel.send(JSON.stringify(value));
    } catch {
      // 通道已不可用；调用方靠 close / reply 超时收敛
    }
  }

  /** 发一帧数据；遇背压异常等排水后重试一次，仍失败则抛。 */
  async sendData(bytes: Uint8Array): Promise<void> {
    if (this.closed || this.channel.readyState !== 'open') {
      throw new BulkTransferError('closed', 'bulk channel closed');
    }
    try {
      this.channel.send(bytes);
      return;
    } catch (err) {
      if (this.channel.readyState !== 'open') {
        throw new BulkTransferError('closed', 'bulk channel closed');
      }
      await this.waitDrain();
      if (this.closed || this.channel.readyState !== 'open') {
        throw new BulkTransferError('closed', 'bulk channel closed');
      }
      try {
        this.channel.send(bytes);
      } catch {
        throw err instanceof Error ? err : new BulkTransferError('unknown', 'bulk send failed');
      }
    }
  }

  waitDrain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    let buffered = 0;
    try {
      buffered = this.channel.bufferedAmount;
    } catch {
      buffered = 0;
    }
    if (buffered <= this.highWater) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  close(): void {
    if (!this.closed) {
      try {
        this.channel.close();
      } catch {
        // 已在关闭中
      }
    }
    this.markClosed();
  }

  private dispatch(data: unknown): void {
    if (this.closed) return;
    if (typeof data === 'string') {
      const control = parseControlJson(data);
      if (control) this.onControl?.(control);
      return;
    }
    const bytes = toBytes(data);
    if (!bytes) return;
    if (this.binaryIsData) {
      this.onData?.(bytes.slice());
      return;
    }
    const control = parseControlJson(new TextDecoder().decode(bytes));
    if (control) this.onControl?.(control);
  }

  private markOpen(): void {
    if (this.opened) return;
    this.opened = true;
    for (const waiter of this.openWaiters.splice(0)) waiter.resolve();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.openWaiters.splice(0)) {
      waiter.reject(new BulkTransferError('closed', 'bulk channel closed'));
    }
    this.flushDrain();
    this.onClosed?.();
  }

  private flushDrain(): void {
    for (const waiter of this.drainWaiters.splice(0)) waiter();
  }
}

/**
 * 直连大文件传输客户端。一次传输一条通道，传完即关。
 *
 * `upload` 只在**传输层**出问题时 reject（通道打不开 / 中途关闭 / 本地越界 / 被 abort）；
 * node 明确回的 `{ok:false, code}` 走正常 resolve，交由调用方决定是否回落 REST。
 */
export class BulkClient {
  private readonly frameSize: number;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly openTimeoutMs: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancelTimer: (handle: unknown) => void;

  constructor(
    private readonly source: BulkChannelSource,
    options: BulkClientOptions = {}
  ) {
    this.frameSize = options.frameSize ?? BULK_FRAME_SIZE;
    this.highWater = options.highWaterBytes ?? DC_HIGH_WATER_BYTES;
    this.lowWater = options.lowWaterBytes ?? DC_LOW_WATER_BYTES;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_BULK_OPEN_TIMEOUT_MS;
    this.schedule =
      options.setTimeoutFn ?? ((fn, ms) => (globalThis as typeof global).setTimeout(fn, ms));
    this.cancelTimer =
      options.clearTimeoutFn ??
      ((handle) => (globalThis as typeof global).clearTimeout(handle as never));
  }

  /** 直连处于 `active` 才可用；否则调用方走 REST。 */
  isAvailable(): boolean {
    try {
      return this.source.getState() === 'active';
    } catch {
      return false;
    }
  }

  async upload(req: BulkUploadRequest): Promise<BulkResult> {
    if (!this.isAvailable()) return { ok: false, code: 'unavailable' };
    if (req.signal?.aborted) throw abortError();

    const session = this.openSession(req.transferId, false);
    let reply: BulkResult | null = null;
    let settleReply: (result: BulkResult) => void = () => {};
    let failReply: (err: Error) => void = () => {};
    const replyPromise = new Promise<BulkResult>((resolve, reject) => {
      settleReply = (result) => {
        if (reply) return;
        reply = result;
        resolve(result);
      };
      failReply = reject;
    });
    replyPromise.catch(() => {
      // 竞速里可能没人接住这次 reject；真正的错误由 upload 自身抛出
    });

    session.onControl = (value) => {
      if (typeof value.ok !== 'boolean') return;
      if (value.ok) {
        settleReply({ ok: true });
        return;
      }
      settleReply({ ok: false, code: typeof value.code === 'string' ? value.code : 'unknown' });
    };
    session.onClosed = () => {
      failReply(new BulkTransferError('closed', 'bulk channel closed'));
    };

    const onAbort = () => {
      session.sendControl({ op: 'abort' });
      failReply(abortError());
    };
    req.signal?.addEventListener('abort', onAbort);

    try {
      await Promise.race([session.ready(this.openTimeoutMs), replyPromise]);
      if (reply) return reply;

      session.sendControl({ op: 'put', transferId: req.transferId, size: req.size });
      req.onProgress?.(0, req.size);

      let sent = 0;
      for await (const frame of iterateBulkFrames(req.source, this.frameSize)) {
        if (reply) return reply;
        if (req.signal?.aborted) throw abortError();
        if (sent + frame.byteLength > req.size) {
          throw new BulkTransferError('too_large', 'source exceeds declared size');
        }
        await Promise.race([session.waitDrain(), replyPromise]);
        if (reply) return reply;
        await session.sendData(frame);
        sent += frame.byteLength;
        req.onProgress?.(sent, req.size);
      }

      if (reply) return reply;
      session.sendControl({ op: 'done' });
      return await replyPromise;
    } catch (err) {
      if (!reply) session.sendControl({ op: 'abort' });
      throw err;
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
      session.close();
    }
  }

  /**
   * 下载：返回的流即 node 侧文件内容。node 的 `{ok:false, code}` 与通道异常一律 error 流，
   * 调用方据此回落 REST；消费方 `cancel()` 会向 node 发 `{op:'abort'}`。
   */
  download(req: BulkDownloadRequest): ReadableStream<Uint8Array> {
    const frameSize = this.frameSize;
    let session: BulkChannelSession | null = null;
    let finished = false;
    let received = 0;
    let onAbort: (() => void) | null = null;

    const cleanup = () => {
      if (onAbort) req.signal?.removeEventListener('abort', onAbort);
      onAbort = null;
      session?.close();
    };

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const fail = (err: Error) => {
          if (finished) return;
          finished = true;
          try {
            controller.error(err);
          } catch {
            // 流已终止
          }
          session?.sendControl({ op: 'abort' });
          cleanup();
        };

        if (!this.isAvailable()) {
          finished = true;
          controller.error(new BulkTransferError('unavailable', 'direct carrier not active'));
          return;
        }
        if (req.signal?.aborted) {
          finished = true;
          controller.error(abortError());
          return;
        }

        const active = this.openSession(req.transferId, true);
        session = active;

        active.onData = (bytes) => {
          if (finished) return;
          if (bytes.byteLength > frameSize) {
            fail(new BulkTransferError('too_large', 'bulk frame exceeds 64 KiB'));
            return;
          }
          received += bytes.byteLength;
          controller.enqueue(bytes);
          req.onProgress?.(received);
        };
        active.onControl = (value) => {
          if (finished) return;
          if (value.op === 'eof') {
            finished = true;
            try {
              controller.close();
            } catch {
              // 已关闭
            }
            cleanup();
            return;
          }
          if (value.ok === false) {
            fail(
              new BulkTransferError(
                typeof value.code === 'string' ? value.code : 'unknown',
                'bulk download rejected'
              )
            );
          }
        };
        active.onClosed = () => {
          if (finished) return;
          fail(new BulkTransferError('closed', 'bulk channel closed'));
        };

        onAbort = () => fail(abortError());
        req.signal?.addEventListener('abort', onAbort);

        try {
          await active.ready(this.openTimeoutMs);
          if (finished) return;
          active.sendControl({ op: 'get' });
        } catch (err) {
          fail(err instanceof Error ? err : new BulkTransferError('unknown', 'bulk open failed'));
        }
      },
      cancel: () => {
        if (!finished) {
          finished = true;
          session?.sendControl({ op: 'abort' });
        }
        cleanup();
      },
    });
  }

  private openSession(transferId: string, binaryIsData: boolean): BulkChannelSession {
    const channel = this.source.createDataChannel(bulkChannelLabel(transferId), { ordered: true });
    return new BulkChannelSession(
      channel,
      this.highWater,
      this.lowWater,
      binaryIsData,
      this.schedule,
      this.cancelTimer
    );
  }
}

// ========== 每 node 一个客户端的登记表 ==========
//
// panels / 面板层拿不到 `GatewayConnection`，只知道 `runtime.nodeId`；由建直连控制器的一侧
// （`apps/fe/src/node/node-runtimes.ts`）在挂上控制器时登记，运行时回收时注销。

const bulkClients = new Map<string, BulkClient>();

export function registerBulkClient(nodeId: string, client: BulkClient | null): void {
  if (!nodeId) return;
  if (client) bulkClients.set(nodeId, client);
  else bulkClients.delete(nodeId);
}

export function getBulkClient(nodeId: string): BulkClient | null {
  return bulkClients.get(nodeId) ?? null;
}

export function clearBulkClients(): void {
  bulkClients.clear();
}
