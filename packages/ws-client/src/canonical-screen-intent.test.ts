// HELLO 之后的第一批发送里到底有什么：能力协商成功时 connect-device + 占位订阅 + 首屏意图
// 一起出去；没协商上时首屏照旧排队等 metadata。用假 socket 直接读发出去的帧。

import { describe, expect, test } from 'bun:test';
import {
  GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1,
  GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1,
  wsBorsh,
} from '@vibeterm/shared';
import { buildScreenIntentCommand, supportsScreenIntent } from './canonical-screen-intent';
import { BorshWebSocketClient } from './client';
import { createFakeSocket, helloFrame } from './test-fakes';
import type { GatewayTransportCommand } from './transport-types';
import { WebSocketGatewayTransport } from './websocket-transport';

const SCREEN_REQUEST = new Uint8Array(16).fill(0x51);

const SCREEN_COMMAND: Extract<GatewayTransportCommand, { type: 'request-pane-screen' }> = {
  type: 'request-pane-screen',
  requestId: SCREEN_REQUEST,
  deviceId: 'device-a',
  paneId: '%1',
  byteLimit: 4096,
};

/** 一帧发出去的命令的可读名字：canonical 命令取变体名，其余取 wire kind。 */
function frameName(frame: Uint8Array): string {
  const envelope = wsBorsh.decodeEnvelope(frame);
  if (envelope.kind !== wsBorsh.KIND_CANONICAL_COMMAND) return `kind:${envelope.kind}`;
  return Object.keys(wsBorsh.decodeCanonicalCommandPayload(envelope.payload).command)[0] as string;
}

function subscriptionEpochs(frames: Uint8Array[]): string[] {
  const result: string[] = [];
  for (const frame of frames) {
    const envelope = wsBorsh.decodeEnvelope(frame);
    if (envelope.kind !== wsBorsh.KIND_CANONICAL_COMMAND) continue;
    const command = wsBorsh.decodeCanonicalCommandPayload(envelope.payload).command;
    if (!('SetPaneSubscriptions' in command)) continue;
    for (const item of command.SetPaneSubscriptions.activePanes) {
      result.push(item.pane.serverEpoch.every((byte) => byte === 0) ? 'zero' : 'real');
    }
  }
  return result;
}

function createHarness(capabilities: readonly string[]) {
  const socket = createFakeSocket({ binary: true });
  const client = new BorshWebSocketClient({
    url: 'ws://example.test/ws',
    socketFactory: () => socket,
    heartbeatIntervalMs: 60_000,
  });
  const transport = new WebSocketGatewayTransport(client);
  transport.connect();
  socket.open();
  // 终端现在先于 WS READY 挂载：连设备 / 订阅 / 首屏三条命令都在未就绪时排队
  transport.send({ type: 'connect-device', deviceId: 'device-a' });
  transport.send({
    type: 'set-pane-subscriptions',
    deviceId: 'device-a',
    generation: 1n,
    paneIds: ['%1'],
  });
  transport.send(SCREEN_COMMAND);
  socket.sent.length = 0;
  socket.deliver(helloFrame({ serverVersion: '2.2.0', capabilities: [...capabilities] }));
  return {
    socket,
    transport,
    frames: socket.sent.filter((frame) => frameName(frame) !== 'kind:3'),
  };
}

describe('首屏意图的能力判定与命令构造', () => {
  test('只有网关播报 canonical-screen-intent-v1 才算支持', () => {
    expect(supportsScreenIntent([GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1])).toBe(true);
    expect(supportsScreenIntent([GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1])).toBe(false);
    expect(supportsScreenIntent([])).toBe(false);
  });

  test('意图带 deviceId / paneId / byteLimit，window 留空交给网关解析', () => {
    const command = buildScreenIntentCommand(SCREEN_COMMAND, SCREEN_REQUEST);
    expect(command).toEqual({
      RequestScreenIntent: {
        requestId: SCREEN_REQUEST,
        deviceId: 'device-a',
        windowId: null,
        paneId: '%1',
        byteLimit: 4096,
      },
    });
    // 新变体追加在枚举尾部，能原样 round trip
    expect(
      wsBorsh.decodeCanonicalCommandPayload(wsBorsh.encodeCanonicalCommandPayload(command)).command
    ).toEqual(command);
  });
});

describe('HELLO 之后的第一批发送', () => {
  test('协商到能力：connect-device + 占位订阅 + 首屏意图同批发出，不发 RequestScreen', () => {
    const { frames } = createHarness([
      GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1,
      GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1,
    ]);
    const sent = frames.map(frameName);
    expect(sent).toContain(`kind:${wsBorsh.KIND_DEVICE_CONNECT}`);
    expect(sent).toContain('SetPaneSubscriptions');
    expect(sent).toContain('RequestScreenIntent');
    expect(sent).not.toContain('RequestScreen');
    // metadata 还没到，占位订阅只能带全零 serverEpoch
    expect(new Set(subscriptionEpochs(frames))).toEqual(new Set(['zero']));
    // 首屏意图排在连设备之后：网关按同一条流顺序处理
    expect(sent.indexOf('RequestScreenIntent')).toBeGreaterThan(
      sent.indexOf(`kind:${wsBorsh.KIND_DEVICE_CONNECT}`)
    );
  });

  test('未协商到能力：首屏不进第一批，留在队列里等 metadata（旧时序）', () => {
    const { frames } = createHarness([GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1]);
    const sent = frames.map(frameName);
    expect(sent).toContain(`kind:${wsBorsh.KIND_DEVICE_CONNECT}`);
    expect(sent).toContain('SetPaneSubscriptions');
    expect(sent).not.toContain('RequestScreenIntent');
    expect(sent).not.toContain('RequestScreen');
  });

  test('canonical 会话建不起来时（网关太旧）一条 canonical 命令都不发', () => {
    const { frames } = createHarness([]);
    const sent = frames.map(frameName);
    expect(sent).toEqual([`kind:${wsBorsh.KIND_DEVICE_CONNECT}`]);
  });
});
