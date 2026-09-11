// 首屏意图（canonical-screen-intent-v1）的能力判定与命令构造。
// metadata 未到达时客户端解析不出 serverEpoch，改用「意图」表达首屏请求：
// (deviceId, windowId?, paneId?) 由网关在 attach 后自行解析，省掉一次 metadata 往返。
// 网关没播报这条能力时一律回退旧时序（见 ./canonical-content-requests）。

import { GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1, type wsBorsh } from '@vibeterm/shared';
import type { GatewayTransportCommand } from './transport-types';

export type ScreenRequestCommand = Extract<
  GatewayTransportCommand,
  { type: 'request-pane-screen' }
>;

export function supportsScreenIntent(capabilities: readonly string[]): boolean {
  return capabilities.includes(GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1);
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
