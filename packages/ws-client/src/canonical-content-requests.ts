// 首屏 / history 请求的发送面：目标可解析时发常规命令，
// 首屏在 metadata 未到达且网关支持 canonical-screen-intent-v1 时改发意图，
// 否则排队等 metadata 落地（旧时序）。

import type { wsBorsh } from '@vibeterm/shared';
import type { PendingContentRequest } from './canonical-content-transactions';
import {
  type ScreenRequestCommand,
  buildScreenIntentCommand,
  supportsScreenIntent,
} from './canonical-screen-intent';
import { clonePendingCommand, copyBytes } from './canonical-state-helpers';
import type { ClientSendResult } from './client';
import type { GatewayTransportCommand } from './transport-types';

export type HistoryRequestCommand = Extract<
  GatewayTransportCommand,
  { type: 'request-pane-history' }
>;

export interface ContentRequestContext {
  capabilities(): readonly string[];
  resolveTarget(deviceId: string, paneId: string): wsBorsh.CanonicalPaneTarget | null;
  rememberRequest(requestId: Uint8Array, request: PendingContentRequest): void;
  cancelRetry(kind: PendingContentRequest['kind'], deviceId: string, paneId: string): void;
  send(command: wsBorsh.CanonicalCommand): ClientSendResult;
  defer(command: GatewayTransportCommand, allowQueue: boolean): ClientSendResult;
}

export function sendScreenRequest(
  ctx: ContentRequestContext,
  command: ScreenRequestCommand,
  allowQueue: boolean
): ClientSendResult {
  const pane = ctx.resolveTarget(command.deviceId, command.paneId);
  if (!pane && !supportsScreenIntent(ctx.capabilities())) {
    return ctx.defer(command, allowQueue);
  }
  const requestId = copyBytes(command.requestId);
  ctx.cancelRetry('screen', command.deviceId, command.paneId);
  ctx.rememberRequest(requestId, {
    kind: 'screen',
    deviceId: command.deviceId,
    paneId: command.paneId,
    // 意图式请求的 serverEpoch 由回包认领（见 ./canonical-content-transactions）
    serverEpoch: pane ? copyBytes(pane.serverEpoch) : new Uint8Array(16),
    serverEpochPending: !pane,
    command: clonePendingCommand(command) as ScreenRequestCommand,
  });
  return ctx.send(
    pane
      ? { RequestScreen: { requestId, pane, byteLimit: command.byteLimit } }
      : buildScreenIntentCommand(command, requestId)
  );
}

export function sendHistoryRequest(
  ctx: ContentRequestContext,
  command: HistoryRequestCommand,
  allowQueue: boolean
): ClientSendResult {
  const pane = ctx.resolveTarget(command.deviceId, command.paneId);
  if (!pane) return ctx.defer(command, allowQueue);
  ctx.cancelRetry('history', command.deviceId, command.paneId);
  const requestId = copyBytes(command.requestId);
  ctx.rememberRequest(requestId, {
    kind: 'history',
    deviceId: command.deviceId,
    paneId: command.paneId,
    serverEpoch: copyBytes(pane.serverEpoch),
    command: clonePendingCommand(command) as HistoryRequestCommand,
  });
  return ctx.send({
    RequestHistory: {
      requestId,
      pane,
      beforeCursor: command.cursor
        ? {
            paneEpoch: copyBytes(command.cursor.paneEpoch),
            historyEpoch: copyBytes(command.cursor.historyEpoch),
            beforeLine: command.cursor.beforeLine,
          }
        : null,
      byteLimit: command.byteLimit,
    },
  });
}
