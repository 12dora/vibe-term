import { SHARE_WS_CLOSE_ENDED } from '@vibeterm/shared/share';
import { WS_CLOSE_LOGIN_REQUIRED } from './mesh-deps';

const TERMINAL_RESET_PREFIX = 'vibeterm-close:';
/** tmex 时期的前缀：混合版本期继续解析对端发来的旧值，全网 ≥2.0 后可删。 */
const LEGACY_TERMINAL_RESET_PREFIX = 'tmex-close:';

/**
 * 网关回收「证明过心跳却长时间无入站」的会话时用的关闭码。浏览器按普通断线重连；
 * 它必须是终止码，否则 Hub 会 failover 并用缓存的视口声明在节点上复活这条僵尸会话。
 */
export const WS_CLOSE_IDLE_TIMEOUT = 4408;
export const WS_CLOSE_IDLE_TIMEOUT_REASON = 'idle-timeout';

/**
 * 终止性关闭码：节点端主动关闭该连接，Hub 收到后直接把关闭码透给浏览器，
 * 不再走 failover / 续流（否则要等重连超时才断，且丢掉原始关闭码）。
 * 4401 / 4410 浏览器不再重连；4408 由浏览器自行新建连接。
 */
export const TERMINAL_STREAM_CLOSE_CODES: ReadonlySet<number> = new Set([
  WS_CLOSE_LOGIN_REQUIRED,
  SHARE_WS_CLOSE_ENDED,
  WS_CLOSE_IDLE_TIMEOUT,
]);

export function isTerminalStreamCloseCode(code: number): boolean {
  return TERMINAL_STREAM_CLOSE_CODES.has(code);
}

/** 编码进 mux RST 的 reason，随 RST 帧送达对端的 `stream.closed.message`。 */
export function encodeTerminalStreamClose(code: number, reason: string): string {
  return `${TERMINAL_RESET_PREFIX}${code}:${reason.replace(/[\r\n]/g, ' ').slice(0, 120)}`;
}

export function decodeTerminalStreamClose(
  message: string | null | undefined
): { code: number; reason: string } | null {
  if (!message) return null;
  const prefix = message.startsWith(TERMINAL_RESET_PREFIX)
    ? TERMINAL_RESET_PREFIX
    : message.startsWith(LEGACY_TERMINAL_RESET_PREFIX)
      ? LEGACY_TERMINAL_RESET_PREFIX
      : null;
  if (!prefix) return null;
  const rest = message.slice(prefix.length);
  const split = rest.indexOf(':');
  if (split <= 0) return null;
  const code = Number(rest.slice(0, split));
  if (!Number.isInteger(code) || !isTerminalStreamCloseCode(code)) return null;
  return { code, reason: rest.slice(split + 1) };
}

export function isTerminalStreamClose(info: { code?: number } | null | undefined): boolean {
  return typeof info?.code === 'number' && isTerminalStreamCloseCode(info.code);
}
