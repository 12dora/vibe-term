import { describe, expect, test } from 'bun:test';
import {
  CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1,
  GATEWAY_CAPABILITY_HELLO_SCREEN_INTENT_V1,
  wsBorsh,
} from '@vibeterm/shared';

import { negotiateHello } from './hello-negotiate';
import { createBorshTestWs } from './test-helpers';

const REQUEST_ID = new Uint8Array(16).fill(0x51);

function legacyHello(): Uint8Array {
  return wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
    clientImpl: 'vibeterm-fe',
    clientVersion: '2.3.0',
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    supportsCompression: false,
    supportsDiffSnapshot: false,
  });
}

function helloWithIntent(intent: wsBorsh.HelloScreenIntent | null): Uint8Array {
  return wsBorsh.encodeHelloC2S({
    clientImpl: 'vibeterm-fe',
    clientVersion: '2.3.0',
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    supportsCompression: false,
    supportsDiffSnapshot: false,
    clientCapabilities: [CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1],
    screenIntent: intent,
  });
}

describe('HELLO negotiate screenIntent', () => {
  test('2.3.0 HELLO：不带 hello-screen-intent 能力，也不调用 applyHelloScreenIntent', async () => {
    const ws = createBorshTestWs();
    let applied = 0;
    await negotiateHello(
      {
        sendError() {},
        sendEnvelope(session, kind, payload) {
          session.primary.send(wsBorsh.encodeEnvelope(kind, payload, 1));
        },
        closeSession() {},
        getOrCreateCanonicalSession() {
          return {
            applyHelloScreenIntent: async () => {
              applied += 1;
            },
          } as never;
        },
      },
      ws,
      1,
      legacyHello()
    );
    expect(applied).toBe(0);
    expect(ws.borshState.negotiated).toBe(true);
    const hello = wsBorsh.decodePayload(
      wsBorsh.schema.HelloS2CSchema,
      wsBorsh.decodeEnvelope(ws.sent[0] as Uint8Array).payload
    );
    expect(hello.capabilities).not.toContain(GATEWAY_CAPABILITY_HELLO_SCREEN_INTENT_V1);
  });

  test('新客户端带 screenIntent：HELLO_S2C 回显能力并 applyHelloScreenIntent', async () => {
    const ws = createBorshTestWs();
    const seen: wsBorsh.HelloScreenIntent[] = [];
    await negotiateHello(
      {
        sendError() {},
        sendEnvelope(session, kind, payload) {
          session.primary.send(wsBorsh.encodeEnvelope(kind, payload, 1));
        },
        closeSession() {},
        getOrCreateCanonicalSession() {
          return {
            applyHelloScreenIntent: async (intent: wsBorsh.HelloScreenIntent) => {
              seen.push(intent);
            },
          } as never;
        },
      },
      ws,
      1,
      helloWithIntent({
        requestId: REQUEST_ID,
        deviceId: 'device-a',
        windowId: null,
        paneId: '%1',
        byteLimit: 4096,
      })
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.deviceId).toBe('device-a');
    const hello = wsBorsh.decodePayload(
      wsBorsh.schema.HelloS2CSchema,
      wsBorsh.decodeEnvelope(ws.sent[0] as Uint8Array).payload
    );
    expect(hello.capabilities).toContain(GATEWAY_CAPABILITY_HELLO_SCREEN_INTENT_V1);
  });

  test('只有能力位没有 intent：不 apply，S2C 不回显 hello-screen-intent', async () => {
    const ws = createBorshTestWs();
    let applied = 0;
    await negotiateHello(
      {
        sendError() {},
        sendEnvelope(session, kind, payload) {
          session.primary.send(wsBorsh.encodeEnvelope(kind, payload, 1));
        },
        closeSession() {},
        getOrCreateCanonicalSession() {
          return {
            applyHelloScreenIntent: async () => {
              applied += 1;
            },
          } as never;
        },
      },
      ws,
      1,
      helloWithIntent(null)
    );
    expect(applied).toBe(0);
    const hello = wsBorsh.decodePayload(
      wsBorsh.schema.HelloS2CSchema,
      wsBorsh.decodeEnvelope(ws.sent[0] as Uint8Array).payload
    );
    expect(hello.capabilities).not.toContain(GATEWAY_CAPABILITY_HELLO_SCREEN_INTENT_V1);
  });
});
