// 浏览器 WebSocket 无法设置握手头，会话持有证明（PoP）只能放进升级 URL 的 `pop` 查询参数。
// 签名是异步的（WebCrypto），而 `SocketFactory` 是同步的：需要签名时先交出一个延迟打开的壳，
// 签完才真正 `new WebSocket`。不需要证明（没有注册签名器 / 目标节点没有 PoP 会话）时同步直开，行为不变。

import type { WebSocketLike } from './client-socket';

/** 返回 null = 该 URL 不需要证明；否则 resolve 出带 `pop` 参数的新 URL。每次建 socket（含重连）重新调用。 */
export type WsUrlSigner = (url: string) => Promise<string> | null;

const WS_CLOSED = 3;
const CLOSE_NORMAL = 1000;
const CLOSE_ABNORMAL = 1006;

/** 服务端因持有证明缺失 / 无效拒绝 WS 时的关闭码与原因（关闭码沿用会话失效的 4401，靠原因区分）。 */
export const WS_POP_CLOSE_CODE = 4401;
const POP_CLOSE_REASONS = new Set(['POP_REQUIRED', 'POP_INVALID']);
/** 同一连接在这个窗口内第二次被 POP 拒绝，就不再当作可重签恢复。 */
export const WS_POP_RETRY_WINDOW_MS = 30_000;

/** 能否替该 WS URL 的目标节点重新签名（宿主注册）。 */
export type WsPopRecovery = (url: string) => boolean;

let signer: WsUrlSigner | null = null;
let recovery: WsPopRecovery | null = null;

export function setWsUrlSigner(next: WsUrlSigner | null): void {
  signer = next;
}

export function setWsPopRecovery(next: WsPopRecovery | null): void {
  recovery = next;
}

export function isPopClose(code: number, reason: string): boolean {
  return code === WS_POP_CLOSE_CODE && POP_CLOSE_REASONS.has(reason);
}

/**
 * 一条连接的 POP 关闭处置：返回 true = 这次关闭不是登出，由客户端走正常重连（重连会重新签名）。
 * 钥签不了该节点、或窗口内已经重试过一次仍被拒，返回 false，交给原有的会话失效流程。
 */
export function createPopCloseGate(
  now: () => number = Date.now
): (code: number, reason: string, url: string) => boolean {
  let lastRetryAt = Number.NEGATIVE_INFINITY;
  return (code, reason, url) => {
    if (!isPopClose(code, reason) || !recovery?.(url)) return false;
    const at = now();
    if (at - lastRetryAt <= WS_POP_RETRY_WINDOW_MS) {
      lastRetryAt = Number.NEGATIVE_INFINITY;
      return false;
    }
    lastRetryAt = at;
    return true;
  };
}

type SocketCtor = new (url: string) => WebSocketLike;

function openNative(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: SocketCtor }).WebSocket;
  if (!Ctor) throw new Error('WebSocket unavailable');
  return new Ctor(url);
}

/** 签名完成前先占位的 socket：句柄与 `binaryType` 暂存，真 socket 一建出来就转接过去。 */
class DeferredSocket implements WebSocketLike {
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  private real: WebSocketLike | null = null;
  private closed = false;
  private pendingBinaryType: WebSocketLike['binaryType'] = 'blob';

  constructor(
    pending: Promise<string>,
    private readonly open: (url: string) => WebSocketLike
  ) {
    pending.then(
      (url) => this.connect(url),
      () => this.fail(CLOSE_ABNORMAL)
    );
  }

  get readyState(): number {
    if (this.real) return this.real.readyState;
    return this.closed ? WS_CLOSED : 0;
  }

  get binaryType(): WebSocketLike['binaryType'] {
    return this.real ? this.real.binaryType : this.pendingBinaryType;
  }

  set binaryType(value: WebSocketLike['binaryType']) {
    this.pendingBinaryType = value;
    if (this.real) this.real.binaryType = value;
  }

  send(data: Parameters<WebSocketLike['send']>[0]): void {
    if (!this.real) throw new Error('WebSocket is not open yet');
    this.real.send(data);
  }

  close(code?: number, reason?: string): void {
    if (this.real) this.real.close(code, reason);
    else this.fail(code ?? CLOSE_NORMAL);
  }

  private connect(url: string): void {
    if (this.closed) return;
    try {
      const socket = this.open(url);
      socket.binaryType = this.pendingBinaryType;
      socket.onopen = (event) => this.onopen?.(event);
      socket.onmessage = (event) => this.onmessage?.(event);
      socket.onerror = (event) => this.onerror?.(event);
      socket.onclose = (event) => this.onclose?.(event);
      this.real = socket;
    } catch {
      this.fail(CLOSE_ABNORMAL);
    }
  }

  private fail(code: number): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => {
      if (code === CLOSE_ABNORMAL) this.onerror?.();
      this.onclose?.({ code, reason: '' });
    });
  }
}

/** 浏览器侧打开 WS 的唯一入口：目标节点有 PoP 会话时先签名再开，重连同样重新签。 */
export function openSignedSocket(
  url: string,
  open: (url: string) => WebSocketLike = openNative
): WebSocketLike {
  const pending = signer?.(url) ?? null;
  if (pending === null) return open(url);
  return new DeferredSocket(pending, open);
}
