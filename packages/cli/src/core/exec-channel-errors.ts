// exec 通道的错误翻译：ERROR 帧与 WS 关闭码 → CLI 错误类型（退出码由 main.ts 统一翻译）。

import type { ExecErrorPayload } from '@vibeterm/shared/exec-channel';
import {
  CliError,
  EXIT_NETWORK,
  NetworkError,
  NotFoundError,
  PermissionError,
  UsageError,
} from './errors';
import {
  EXEC_CLOSE_FORBIDDEN,
  EXEC_CLOSE_PROTOCOL,
  EXEC_CLOSE_TAKEN_OVER,
  EXEC_CLOSE_UNAUTHORIZED,
  EXEC_CLOSE_UNSUPPORTED,
} from './exec-channel-socket';
import { loginRequiredError } from './http';

/** 目标 node 不支持 exec 通道（WS 4404 / 升级请求 404）：调用方可回退到旧的 `POST /api/exec`。 */
export class ExecChannelUnsupportedError extends CliError {
  constructor(nodeId: string) {
    super(
      `node ${nodeId} does not support the exec channel`,
      EXIT_NETWORK,
      'upgrade the node to a newer vibeterm release'
    );
    this.name = 'ExecChannelUnsupportedError';
  }
}

export const SESSION_ENDED_MESSAGE = 'connection lost and the remote session has ended';

export function errorFromFrame(payload: ExecErrorPayload): CliError {
  const message = payload.message || payload.code;
  switch (payload.code) {
    case 'device_not_found':
      return new NotFoundError(message);
    case 'invalid_request':
      return new UsageError(message);
    case 'forbidden':
      return new PermissionError(message, 'forbidden');
    case 'session_not_found':
    case 'resume_gap':
      return new NetworkError(SESSION_ENDED_MESSAGE);
    default:
      return new NetworkError(message);
  }
}

/** 返回 null 表示「可重连的链路丢失」；否则是不应重试的终态错误。 */
export function errorFromClose(nodeId: string, code: number, reason: string): CliError | null {
  switch (code) {
    case EXEC_CLOSE_UNAUTHORIZED:
      return loginRequiredError(nodeId, reason);
    case EXEC_CLOSE_FORBIDDEN:
      return new PermissionError(reason || 'exec channel access denied', 'forbidden');
    case EXEC_CLOSE_UNSUPPORTED:
      return new ExecChannelUnsupportedError(nodeId);
    case EXEC_CLOSE_TAKEN_OVER:
      return new NetworkError('session was taken over by another connection');
    case EXEC_CLOSE_PROTOCOL:
      return new NetworkError(`exec channel protocol error${reason ? `: ${reason}` : ''}`);
    default:
      return null;
  }
}
