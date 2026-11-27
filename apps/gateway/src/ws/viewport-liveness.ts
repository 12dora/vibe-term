import { wsBorsh } from '@vibeterm/shared';
import { logAt } from '../log/level';
import { WS_CLOSE_IDLE_TIMEOUT, WS_CLOSE_IDLE_TIMEOUT_REASON } from '../mesh/stream-close-code';
import type { GatewaySession } from './gateway-session';
import { formatWsClientFields } from './session-close';
import { parseViewportClaimKey } from './viewport-policy';

/** 3× HELLO 播报的 15 s 心跳，且大于客户端可见态最长 30 s 的 PING 间隔。 */
export const VIEWPORT_CLAIM_STALE_MS = 45_000;
/** 大于 3× 隐藏态 60 s pong 超时，也大于 Chrome 后台每分钟一次的定时器节流。 */
export const SESSION_IDLE_TIMEOUT_MS = 180_000;
export const VIEWPORT_LIVENESS_SWEEP_MS = 5_000;

/** 这些客户端连上即按 HELLO 播报的间隔发 PING；入口 failover 重放的 HELLO 也带同一标识。 */
export const HEARTBEAT_CLIENT_IMPLS: ReadonlySet<string> = new Set([
  'vibeterm-fe',
  'tmex-fe',
  'vibeterm-cli',
]);

/**
 * 失联判定只对已知会发心跳的会话生效：其余客户端无法按静默判断死活，
 * 它们的声明照常参与仲裁，也不会被回收。
 */
export function isSessionStale(session: GatewaySession, now: number): boolean {
  return session.heartbeatExpected && now - session.lastInboundAt > VIEWPORT_CLAIM_STALE_MS;
}

export interface ViewportLivenessHost {
  readonly connectedClients: Set<GatewaySession>;
  readonly deps: { now: () => number };
  applyViewportPolicy(deviceId: string, windowId: string, seen: Set<string>): void;
  closeSession(session: GatewaySession, code: number, reason: string): void;
}

function visibleClaimWindows(
  session: GatewaySession
): Array<{ key: string; deviceId: string; windowId: string }> {
  const windows: Array<{ key: string; deviceId: string; windowId: string }> = [];
  for (const [key, claim] of session.viewportClaims) {
    if (claim.visible) windows.push({ key, ...parseViewportClaimKey(key) });
  }
  return windows;
}

export class ViewportLiveness {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: ViewportLivenessHost) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), VIEWPORT_LIVENESS_SWEEP_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 每个解码出的入站帧（含分片）都先经过这里盖章；返回它是否让失联会话复活（重算留到该消息处理完之后）。 */
  stampInbound(session: GatewaySession, kind: number): boolean {
    const now = this.host.deps.now();
    const revived = isSessionStale(session, now);
    session.lastInboundAt = now;
    session.staleSwept = false;
    if (kind === wsBorsh.KIND_PING) session.heartbeatExpected = true;
    return revived;
  }

  /** 失联后先到的是分片：记下复活，等整条消息重组并处理完再重算。 */
  holdRevival(session: GatewaySession, revived: boolean): void {
    if (revived) session.reviveRecomputePending = true;
  }

  takeRevival(session: GatewaySession): boolean {
    const pending = session.reviveRecomputePending;
    session.reviveRecomputePending = false;
    return pending;
  }

  /**
   * 复活的会话按它最新的声明重算可见 window：只由触发复活的那条消息在其处理完成后执行，
   * 避免本帧撤回 / 改写的旧声明先赢一次，也不借用更早消息的完成回调。
   */
  afterHandled(
    session: GatewaySession,
    handled: Promise<void> | undefined,
    revived: boolean
  ): void {
    if (!revived) return;
    const recompute = (): void => {
      if (!session.closed) this.recompute(session);
    };
    if (handled) void handled.then(recompute);
    else recompute();
  }

  sweep(): void {
    const now = this.host.deps.now();
    for (const session of [...this.host.connectedClients]) {
      if (session.closed || !session.heartbeatExpected) continue;
      const idleMs = now - session.lastInboundAt;
      if (idleMs > SESSION_IDLE_TIMEOUT_MS && session.idleClosable) {
        logAt('info', `[ws] client idle timeout ${formatWsClientFields(session)} idleMs=${idleMs}`);
        this.host.closeSession(session, WS_CLOSE_IDLE_TIMEOUT, WS_CLOSE_IDLE_TIMEOUT_REASON);
        continue;
      }
      if (session.staleSwept || idleMs <= VIEWPORT_CLAIM_STALE_MS) continue;
      session.staleSwept = true;
      session.reviveRecomputePending = false;
      this.recompute(session);
    }
  }

  private recompute(session: GatewaySession): void {
    const seen = new Set<string>();
    for (const window of visibleClaimWindows(session)) {
      this.host.applyViewportPolicy(window.deviceId, window.windowId, seen);
    }
  }
}
