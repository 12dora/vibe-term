import { SHARE_WS_CLOSE_ENDED } from '@tmex/shared/share';
import { WS_CLOSE_LOGIN_REQUIRED } from './mesh-deps';

const TERMINAL_RESET_PREFIX = 'tmex-close:';

/**
 * 终止性关闭码：节点端主动关闭该连接且重连也不会成功，Hub 收到后直接断浏览器，
 * 不再走 failover（否则要等重连超时才断，且丢掉原始关闭码）。
 */
export const TERMINAL_STREAM_CLOSE_CODES: ReadonlySet<number> = new Set([
  WS_CLOSE_LOGIN_REQUIRED,
  SHARE_WS_CLOSE_ENDED,
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
  if (!message || !message.startsWith(TERMINAL_RESET_PREFIX)) return null;
  const rest = message.slice(TERMINAL_RESET_PREFIX.length);
  const split = rest.indexOf(':');
  if (split <= 0) return null;
  const code = Number(rest.slice(0, split));
  if (!Number.isInteger(code) || !isTerminalStreamCloseCode(code)) return null;
  return { code, reason: rest.slice(split + 1) };
}

export function isTerminalStreamClose(info: { code?: number } | null | undefined): boolean {
  return typeof info?.code === 'number' && isTerminalStreamCloseCode(info.code);
}
