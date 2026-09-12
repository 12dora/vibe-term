// 首屏意图（canonical-screen-intent-v1）的能力判定与命令构造。
// metadata 未到达时客户端解析不出 serverEpoch，改用「意图」表达首屏请求：
// (deviceId, windowId?, paneId?) 由网关在 attach 后自行解析，省掉一次 metadata 往返。
// 网关没播报这条能力时一律回退旧时序（见 ./canonical-content-requests）。
// hello-screen-intent-v1：同一份 payload 可挂进 HELLO_C2S；网关回显该能力时不再 post-HELLO 重发。

import {
  GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1,
  GATEWAY_CAPABILITY_HELLO_SCREEN_INTENT_V1,
  type wsBorsh,
} from '@vibeterm/shared';

type HelloScreenIntent = wsBorsh.HelloScreenIntent;
import type { PendingContentRequest } from './canonical-content-transactions';
import { bytesEqual, clonePendingCommand, copyBytes } from './canonical-state-helpers';
import type { GatewayTransportCommand } from './transport-types';

export type ScreenRequestCommand = Extract<
  GatewayTransportCommand,
  { type: 'request-pane-screen' }
>;

export function supportsScreenIntent(capabilities: readonly string[]): boolean {
  return capabilities.includes(GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1);
}

export function supportsHelloScreenIntent(capabilities: readonly string[]): boolean {
  return capabilities.includes(GATEWAY_CAPABILITY_HELLO_SCREEN_INTENT_V1);
}

export function screenCommandToHelloIntent(command: ScreenRequestCommand): HelloScreenIntent {
  return {
    requestId: command.requestId,
    deviceId: command.deviceId,
    windowId: null,
    paneId: command.paneId,
    byteLimit: command.byteLimit,
  };
}

export function shouldSkipPostHelloScreenIntent(
  capabilities: readonly string[],
  helloIntent: HelloScreenIntent | null,
  command: ScreenRequestCommand
): boolean {
  return Boolean(
    helloIntent &&
      supportsHelloScreenIntent(capabilities) &&
      bytesEqual(helloIntent.requestId, command.requestId)
  );
}

export function acknowledgeHelloScreenIntent(
  ctx: {
    resolveTarget(deviceId: string, paneId: string): wsBorsh.CanonicalPaneTarget | null;
    rememberRequest(requestId: Uint8Array, request: PendingContentRequest): void;
    cancelRetry(kind: PendingContentRequest['kind'], deviceId: string, paneId: string): void;
  },
  command: ScreenRequestCommand
): 'sent' {
  const pane = ctx.resolveTarget(command.deviceId, command.paneId);
  const requestId = copyBytes(command.requestId);
  ctx.cancelRetry('screen', command.deviceId, command.paneId);
  ctx.rememberRequest(requestId, {
    kind: 'screen',
    deviceId: command.deviceId,
    paneId: command.paneId,
    serverEpoch: pane ? copyBytes(pane.serverEpoch) : new Uint8Array(16),
    serverEpochPending: !pane,
    command: clonePendingCommand(command) as ScreenRequestCommand,
  });
  return 'sent';
}

export function buildScreenIntentCommand(
  command: ScreenRequestCommand,
  requestId: Uint8Array
): wsBorsh.CanonicalCommand {
  return {
    RequestScreenIntent: {
      requestId,
      deviceId: command.deviceId,
      // 本地拓扑只给得出 pane id；window 留空由网关按设备活动窗口解析
      windowId: null,
      paneId: command.paneId,
      byteLimit: command.byteLimit,
    },
  };
}
