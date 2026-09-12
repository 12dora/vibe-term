import { describe, expect, test } from 'bun:test';
import {
  CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1,
  GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1,
  GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1,
  GATEWAY_CAPABILITY_HELLO_SCREEN_INTENT_V1,
  wsBorsh,
} from '@vibeterm/shared';
import { CanonicalStateClient } from './canonical-state-client';
import { BorshWebSocketClient } from './client';
import { createFakeSocket, helloFrame } from './test-fakes';
import type { GatewayTransportCommand } from './transport-types';

const SCREEN_REQUEST = new Uint8Array(16).fill(0x51);
const SCREEN_COMMAND: Extract<GatewayTransportCommand, { type: 'request-pane-screen' }> = {
  type: 'request-pane-screen',
  requestId: SCREEN_REQUEST,
  deviceId: 'device-a',
  paneId: '%1',
  byteLimit: 4096,
};

function decodeHelloC2S(frame: Uint8Array): wsBorsh.HelloC2S {
  const envelope = wsBorsh.decodeEnvelope(frame);
  expect(envelope.kind).toBe(wsBorsh.KIND_HELLO_C2S);
  return wsBorsh.decodeHelloC2S(envelope.payload);
}

describe('HELLO_C2S 携带 screenIntent', () => {
  test('provider 有意图时 HELLO 带能力位和 screenIntent', () => {
    const socket = createFakeSocket({ binary: true });
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => socket,
      heartbeatIntervalMs: 60_000,
    });
    client.setHelloScreenIntentProvider(() => ({
      requestId: SCREEN_REQUEST,
      deviceId: 'device-a',
      windowId: null,
      paneId: '%1',
      byteLimit: 4096,
    }));
    client.connect();
    socket.open();
    const hello = decodeHelloC2S(socket.sent[0] as Uint8Array);
    expect(hello.clientCapabilities).toContain(CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1);
    expect(hello.screenIntent).toEqual({
      requestId: SCREEN_REQUEST,
      deviceId: 'device-a',
      windowId: null,
      paneId: '%1',
      byteLimit: 4096,
    });
    client.disconnect();
  });

  test('无 provider：HELLO 仍带能力位，intent 为 null（2.3.0 网关可忽略尾部）', () => {
    const socket = createFakeSocket({ binary: true });
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => socket,
      heartbeatIntervalMs: 60_000,
    });
    client.connect();
    socket.open();
    const hello = decodeHelloC2S(socket.sent[0] as Uint8Array);
    expect(hello.clientCapabilities).toContain(CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1);
    expect(hello.screenIntent).toBeNull();
    const legacy = wsBorsh.schema.HelloC2SSchema.deserialize(
      wsBorsh.decodeEnvelope(socket.sent[0] as Uint8Array).payload
    );
    expect(legacy.clientImpl).toBe('vibeterm-fe');
    client.disconnect();
  });
});

describe('网关回显 hello-screen-intent-v1 时不重复发 intent', () => {
  test('S2C 带该能力：只登记 requestId，不再发 RequestScreenIntent', () => {
    const sent: string[] = [];
    const canonical = new CanonicalStateClient({
      emit: () => {},
      send: (message) => {
        const command = wsBorsh.decodeCanonicalCommandPayload(message.payload).command;
        sent.push(Object.keys(command)[0] as string);
        return 'sent';
      },
      effectiveMaxFrameBytes: () => 32 * 1024,
    });
    canonical.stageCommand(SCREEN_COMMAND);
    canonical.setServerCapabilities([
      GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1,
      GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1,
      GATEWAY_CAPABILITY_HELLO_SCREEN_INTENT_V1,
    ]);
    canonical.activate();
    canonical.sendCommand(SCREEN_COMMAND);
    expect(sent).not.toContain('RequestScreenIntent');
    expect(sent).not.toContain('RequestScreen');
    canonical.dispose();
  });

  test('旧网关不回显该能力：仍走 post-HELLO RequestScreenIntent', () => {
    const sent: string[] = [];
    const canonical = new CanonicalStateClient({
      emit: () => {},
      send: (message) => {
        const command = wsBorsh.decodeCanonicalCommandPayload(message.payload).command;
        sent.push(Object.keys(command)[0] as string);
        return 'sent';
      },
      effectiveMaxFrameBytes: () => 32 * 1024,
    });
    canonical.stageCommand(SCREEN_COMMAND);
    canonical.setServerCapabilities([
      GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1,
      GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1,
    ]);
    canonical.activate();
    canonical.sendCommand(SCREEN_COMMAND);
    expect(sent).toContain('RequestScreenIntent');
    canonical.dispose();
  });
});

describe('混版本：旧网关 HELLO_S2C 后仍发 intent', () => {
  test('HELLO_S2C 只有 canonical-screen-intent-v1 时第一批仍含 RequestScreenIntent', () => {
    const socket = createFakeSocket({ binary: true });
    const client = new BorshWebSocketClient({
      url: 'ws://example.test/ws',
      socketFactory: () => socket,
      heartbeatIntervalMs: 60_000,
    });
    const canonical = new CanonicalStateClient({
      emit: () => {},
      send: (message) => client.send(message.kind, message.payload),
      effectiveMaxFrameBytes: () => 32 * 1024,
    });
    client.setHelloScreenIntentProvider(() => canonical.peekHelloScreenIntent());
    canonical.stageCommand(SCREEN_COMMAND);
    client.connect();
    socket.open();
    socket.sent.length = 0;
    socket.deliver(
      helloFrame({
        serverVersion: '2.3.0',
        capabilities: [
          GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1,
          GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1,
        ],
      })
    );
    canonical.setServerCapabilities([
      GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1,
      GATEWAY_CAPABILITY_CANONICAL_SCREEN_INTENT_V1,
    ]);
    canonical.activate();
    canonical.sendCommand(SCREEN_COMMAND);
    const names = socket.sent
      .map((frame) => {
        const envelope = wsBorsh.decodeEnvelope(frame);
        if (envelope.kind !== wsBorsh.KIND_CANONICAL_COMMAND) return `kind:${envelope.kind}`;
        return Object.keys(wsBorsh.decodeCanonicalCommandPayload(envelope.payload).command)[0];
      })
      .filter((name) => name !== 'kind:3');
    expect(names).toContain('RequestScreenIntent');
    client.disconnect();
    canonical.dispose();
  });
});
