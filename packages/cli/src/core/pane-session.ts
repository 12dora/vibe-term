// 设备会话：把 `ctx.openSocket()` 拿到的 Gateway WS 收敛成「连设备 → 等会话树 → 订阅 pane →
// 收字节 / 发按键」这一串动作，term 与 tmux 两个命令组共用。
//
// 元数据折叠不在这里重做：`@vibeterm/ws-client` 的 canonical 客户端已经把
// SourceMetadataSnapshot / Patch 折成 `StateSnapshotPayload`，本模块只留最新一份，
// 定位窗口 / pane 一律用 `@vibeterm/ws-client/canonical-tree` 的纯函数。

import type { EventTmuxPayload, TmuxSession } from '@vibeterm/shared';
import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
  GatewayTerminalData,
  GatewayTransport,
  GatewayTransportEvent,
} from '@vibeterm/ws-client';
import { NetworkError } from './errors';

export const SCREEN_BYTE_LIMIT = 512 * 1024;
export const HISTORY_PAGE_BYTE_LIMIT = 256 * 1024;

export interface DeviceSessionEvents {
  onPaneData?(frame: GatewayTerminalData): void;
  onScreen?(snapshot: GatewayPaneScreenSnapshot): void;
  onHistory?(page: GatewayPaneHistoryPage): void;
  onRebase?(deviceId: string, paneId: string | undefined, reason: GatewayRebaseReason): void;
  onTree?(session: TmuxSession | null): void;
  onTmuxEvent?(event: EventTmuxPayload): void;
  /** 设备侧断线 / 网关断流：调用方据此收尾（attach 会尝试重连一次）。 */
  onDetached?(reason: string): void;
}

function randomRequestId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * 一台设备的会话面。构造后必须 `connect()`；用完 `dispose()`（它会退订并断开设备，
 * 但不关 socket——socket 由 `ctx.openSocket()` 的调用方关）。
 */
export class DeviceSession {
  private readonly unsubscribe: () => void;
  private tree: TmuxSession | null = null;
  private connected = false;
  private generation = 0n;
  private subscribed: string[] = [];
  private readonly treeWaiters: Array<(session: TmuxSession) => void> = [];
  private readonly connectWaiters: Array<(value: undefined) => void> = [];
  private disposed = false;

  constructor(
    private readonly transport: GatewayTransport,
    readonly deviceId: string,
    private readonly events: DeviceSessionEvents = {}
  ) {
    this.unsubscribe = transport.onEvent((event) => this.handle(event));
  }

  session(): TmuxSession | null {
    return this.tree;
  }

  /** 连设备并等到第一份会话树；超时抛网络错误。 */
  async connect(timeoutMs: number): Promise<TmuxSession> {
    this.transport.send({ type: 'connect-device', deviceId: this.deviceId });
    await this.await_<undefined>(
      this.connectWaiters,
      timeoutMs,
      `device ${this.deviceId} did not connect`
    );
    return this.awaitTree(timeoutMs);
  }

  /** 等一份（新的）会话树。已有树时立即返回。 */
  async awaitTree(timeoutMs: number): Promise<TmuxSession> {
    if (this.tree) return this.tree;
    return this.await_(this.treeWaiters, timeoutMs, `device ${this.deviceId} sent no tmux session`);
  }

  /** 等到 `predicate` 在会话树上成立；用于控制命令的落地确认。 */
  async awaitTreeChange(
    predicate: (session: TmuxSession) => boolean,
    timeoutMs: number,
    what: string
  ): Promise<TmuxSession> {
    if (this.tree && predicate(this.tree)) return this.tree;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new NetworkError(`timed out waiting for ${what}`);
      const next = await this.await_(this.treeWaiters, remaining, `timed out waiting for ${what}`);
      if (predicate(next)) return next;
    }
  }

  subscribe(paneIds: readonly string[]): void {
    this.subscribed = [...new Set(paneIds)].sort();
    this.generation += 1n;
    this.transport.send({
      type: 'set-pane-subscriptions',
      deviceId: this.deviceId,
      generation: this.generation,
      paneIds: [...this.subscribed],
    });
  }

  requestScreen(paneId: string, byteLimit = SCREEN_BYTE_LIMIT): void {
    this.transport.send({
      type: 'request-pane-screen',
      requestId: randomRequestId(),
      deviceId: this.deviceId,
      paneId,
      byteLimit,
    });
  }

  requestHistory(
    paneId: string,
    cursor: GatewayHistoryCursor | null,
    byteLimit = HISTORY_PAGE_BYTE_LIMIT
  ): void {
    this.transport.send({
      type: 'request-pane-history',
      requestId: randomRequestId(),
      deviceId: this.deviceId,
      paneId,
      cursor,
      byteLimit,
    });
  }

  /**
   * 发按键。wire 上的 TerminalInput 载荷是 UTF-8 字节，因此这里只能收字符串——
   * 非 UTF-8 的任意字节序列在浏览器端同样发不出去（见 docs/development/cli-architecture.md）。
   */
  sendInput(paneId: string, data: string): void {
    if (!data) return;
    this.transport.send({
      type: 'terminal-input',
      deviceId: this.deviceId,
      paneId,
      data,
      isComposing: false,
    });
  }

  resize(paneId: string, cols: number, rows: number): void {
    this.transport.send({ type: 'terminal-resize', deviceId: this.deviceId, paneId, cols, rows });
  }

  send(command: Parameters<GatewayTransport['send']>[0]): void {
    this.transport.send(command);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.connected) this.transport.send({ type: 'disconnect-device', deviceId: this.deviceId });
    this.unsubscribe();
  }

  private handle(event: GatewayTransportEvent): void {
    if (event.type === 'device-connected' && event.deviceId === this.deviceId) {
      this.connected = true;
      for (const resolve of this.connectWaiters.splice(0)) resolve(undefined);
      return;
    }
    if (event.type === 'metadata-snapshot' && event.snapshot.deviceId === this.deviceId) {
      this.applyTree(event.snapshot.session);
      return;
    }
    if (event.type === 'metadata-patch' && event.deviceId === this.deviceId) {
      this.applyTree(event.snapshot.session);
      return;
    }
    if (this.handleContent(event)) return;
    this.handleLifecycle(event);
  }

  /** pane 内容面；处理了就返回 true。 */
  private handleContent(event: GatewayTransportEvent): boolean {
    if (event.type === 'terminal-data' && event.frame.deviceId === this.deviceId) {
      this.events.onPaneData?.(event.frame);
    } else if (event.type === 'screen-snapshot' && event.snapshot.deviceId === this.deviceId) {
      this.events.onScreen?.(event.snapshot);
    } else if (event.type === 'history-page' && event.page.deviceId === this.deviceId) {
      this.events.onHistory?.(event.page);
    } else if (event.type === 'rebase-required') {
      if (!event.deviceId || event.deviceId === this.deviceId) {
        this.events.onRebase?.(this.deviceId, event.paneId, event.reason);
      }
    } else {
      return false;
    }
    return true;
  }

  /** 生命周期面：tmux 事件与断流。 */
  private handleLifecycle(event: GatewayTransportEvent): void {
    if (event.type === 'tmux-event' && event.event.deviceId === this.deviceId) {
      this.events.onTmuxEvent?.(event.event);
    } else if (event.type === 'device-disconnected' && event.deviceId === this.deviceId) {
      this.connected = false;
      this.events.onDetached?.('device disconnected');
    } else if (event.type === 'connection-state' && event.state === 'CLOSED') {
      this.events.onDetached?.('gateway connection closed');
    }
  }

  private applyTree(session: TmuxSession | null): void {
    this.tree = session;
    this.events.onTree?.(session);
    if (!session) return;
    for (const resolve of this.treeWaiters.splice(0)) resolve(session);
  }

  private await_<T>(waiters: Array<(value: T) => void>, timeoutMs: number, message: string) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(settle);
        if (index >= 0) waiters.splice(index, 1);
        reject(new NetworkError(message));
      }, timeoutMs);
      const settle = (value: T): void => {
        clearTimeout(timer);
        resolve(value);
      };
      waiters.push(settle);
    });
  }
}
