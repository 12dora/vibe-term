import {
  FLAG_HEAD,
  type LinkError,
  MAX_DATA_SEND_PAYLOAD,
  PRIORITY_SEND_RESERVE,
  type WriteOptions,
} from './types';

export interface StreamWriterHost {
  isDead(): boolean;
  deadError(): LinkError;
  /** 同步把帧交给传输层（线上顺序即调用顺序），返回写完的 promise。 */
  sendFrame(flags: number, payload: Uint8Array): Promise<void>;
  /** 该片占用的发送信用，交给上层记账（stream.outstanding / link unacked）。 */
  takeCredit(n: number): void;
}

type CreditWaiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  want: number;
  priority: boolean;
};

/** 窗口小于这个倍数时不留预留额：小窗口本来就没有排队膨胀可言，留了反而写不满。 */
const RESERVE_MIN_WINDOW_RATIO = 4;

export function priorityReserveFor(streamWindow: number): number {
  return streamWindow >= RESERVE_MIN_WINDOW_RATIO * PRIORITY_SEND_RESERVE
    ? PRIORITY_SEND_RESERVE
    : 0;
}

/**
 * 单条流的发送侧：信用等待、优先写插队、分片闸门。
 *
 * - 普通写与优先写各有一条写链，优先写不排在普通写后面。
 * - 调用 `armPriorityReserve()` 后，普通写永远不动窗口末尾的 `PRIORITY_SEND_RESERVE`，
 *   于是窗口被终端输出吃干净时 PONG / DEVICE_LATENCY 这类控制帧仍能立刻发出。预留是
 *   纯发送侧策略，线格式与对端窗口记账都不变，和旧版本互通；默认不预留，文件传输、
 *   端口映射这类只求吞吐的流仍能用满整个窗口。
 * - 每片要么是整条消息，要么是满 `sliceCap`：绝不因为窗口只剩零头就把消息切碎
 *   （接收侧的 ws 转发流 / HTTP 头块按 DATA 边界还原消息）。多片消息在片与片之间
 *   持有分片闸门，优先帧只能插在消息与消息之间。
 */
export class StreamWriter {
  sendWindow: number;
  private readonly host: StreamWriterHost;
  private readonly window: number;
  private readonly sliceCap: number;
  private reserve = 0;
  private waiters: CreditWaiter[] = [];
  private framingBusy = false;
  private framingWaiters: Array<() => void> = [];
  private normalChain: Promise<void> = Promise.resolve();
  private priorityChain: Promise<void> = Promise.resolve();

  constructor(host: StreamWriterHost, streamWindow: number, maxFramePayload: number) {
    this.host = host;
    this.window = streamWindow;
    this.sendWindow = streamWindow;
    this.sliceCap = Math.max(1, Math.min(maxFramePayload, MAX_DATA_SEND_PAYLOAD));
  }

  /** 给优先写留出窗口尾巴。必须在这条流开始写之前调用，否则已在等信用的普通写会饿死。 */
  armPriorityReserve(): void {
    if (this.reserve > 0) return;
    this.reserve = priorityReserveFor(this.window);
  }

  write(bytes: Uint8Array, opts?: WriteOptions): Promise<void> {
    const priority = opts?.priority === true;
    const chain = priority ? this.priorityChain : this.normalChain;
    const run = chain.then(() => this.writeInternal(bytes, opts));
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    if (priority) this.priorityChain = settled;
    else this.normalChain = settled;
    return run;
  }

  /** 两条写链都排空：END 必须排在所有 DATA 之后。 */
  drained(): Promise<void> {
    return Promise.all([this.normalChain, this.priorityChain]).then(() => undefined);
  }

  credit(delta: number): void {
    this.sendWindow += delta;
    this.flushWaiters();
  }

  take(n: number): void {
    this.sendWindow -= n;
  }

  fail(err: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(err);
    this.releaseFraming();
  }

  private async writeInternal(bytes: Uint8Array, opts?: WriteOptions): Promise<void> {
    if (this.host.isDead()) throw this.host.deadError();
    const head = opts?.head === true;
    if (bytes.byteLength === 0) {
      if (!head) return;
      await this.writeEmptyHead();
      return;
    }
    await this.writeSlices(bytes, head, opts?.priority === true);
  }

  private async writeEmptyHead(): Promise<void> {
    await this.awaitFramingIdle();
    if (this.host.isDead()) throw this.host.deadError();
    this.host.takeCredit(0);
    await this.host.sendFrame(FLAG_HEAD, new Uint8Array(0));
  }

  private async writeSlices(bytes: Uint8Array, head: boolean, priority: boolean): Promise<void> {
    const total = bytes.byteLength;
    const multi = total > this.sliceCap;
    let offset = 0;
    let first = true;
    let framed = false;
    try {
      while (offset < total) {
        const want = this.wantFor(total - offset, priority);
        await this.waitForCredit(want, priority);
        if (!framed) await this.awaitFramingIdle();
        if (this.host.isDead()) throw this.host.deadError();
        // 闸门与信用都要在「同一拍」上成立：上面每个 await 之间都可能有别的写抢先，
        // 所以这里同步复核一次，不成立就回到循环头重等。
        if (!framed && this.framingBusy) continue;
        if (this.available(priority) < want) continue;
        if (multi && !framed) {
          this.framingBusy = true;
          framed = true;
        }
        const flags = first && head ? FLAG_HEAD : 0;
        first = false;
        const slice = bytes.subarray(offset, offset + want);
        offset += want;
        this.take(want);
        this.host.takeCredit(want);
        const sent = this.host.sendFrame(flags, slice);
        if (framed && offset >= total) {
          framed = false;
          this.releaseFraming();
        }
        await sent;
      }
    } finally {
      if (framed) this.releaseFraming();
    }
  }

  private available(priority: boolean): number {
    return priority ? this.sendWindow : this.sendWindow - this.reserve;
  }

  private wantFor(remaining: number, priority: boolean): number {
    const cap = priority ? this.window : this.window - this.reserve;
    return Math.max(1, Math.min(remaining, this.sliceCap, cap));
  }

  private waitForCredit(want: number, priority: boolean): Promise<void> {
    if (this.host.isDead()) return Promise.reject(this.host.deadError());
    if (this.available(priority) >= want) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject, want, priority });
    });
  }

  private flushWaiters(): void {
    if (this.waiters.length === 0) return;
    const pending: CreditWaiter[] = [];
    for (const waiter of this.waiters) {
      if (this.available(waiter.priority) >= waiter.want) waiter.resolve();
      else pending.push(waiter);
    }
    this.waiters = pending;
  }

  private async awaitFramingIdle(): Promise<void> {
    while (this.framingBusy && !this.host.isDead()) {
      await new Promise<void>((resolve) => {
        this.framingWaiters.push(resolve);
      });
    }
  }

  private releaseFraming(): void {
    this.framingBusy = false;
    const waiters = this.framingWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
