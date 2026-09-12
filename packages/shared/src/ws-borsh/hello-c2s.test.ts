import { describe, expect, test } from 'bun:test';

import { CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1 } from '../capabilities';
import { HelloC2SWithIntentSchema, decodeHelloC2S, encodeHelloC2S } from './hello-c2s';
import { HelloC2SSchema } from './schema';

const REQUEST_ID = new Uint8Array(16).fill(0x51);

const LEGACY = {
  clientImpl: 'vibeterm-fe',
  clientVersion: '2.3.0',
  maxFrameBytes: 1048576,
  supportsCompression: false,
  supportsDiffSnapshot: false,
};

const INTENT = {
  requestId: REQUEST_ID,
  deviceId: 'device-a',
  windowId: null as string | null,
  paneId: '%1' as string | null,
  byteLimit: 4096,
};

describe('HELLO_C2S 尾部 screenIntent 线格', () => {
  test('2.3.0 载荷（无尾部字段）解码为 null intent，且与 HelloC2SSchema 字节一致', () => {
    const legacyBytes = HelloC2SSchema.serialize(LEGACY);
    const decoded = decodeHelloC2S(legacyBytes);
    expect(decoded.clientImpl).toBe('vibeterm-fe');
    expect(decoded.clientCapabilities).toEqual([]);
    expect(decoded.screenIntent).toBeNull();
    expect([...encodeHelloC2S({ ...decoded })]).toEqual([...legacyBytes]);
  });

  test('新客户端：能力位 + screenIntent 能原样 round trip', () => {
    const encoded = encodeHelloC2S({
      ...LEGACY,
      clientCapabilities: [CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1],
      screenIntent: INTENT,
    });
    const decoded = decodeHelloC2S(encoded);
    expect(decoded.clientCapabilities).toEqual([CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1]);
    expect(decoded.screenIntent).toEqual(INTENT);
  });

  test('新客户端 → 2.3.0 网关：HelloC2SSchema 仍能解出既有字段（忽略尾部）', () => {
    const encoded = encodeHelloC2S({
      ...LEGACY,
      clientCapabilities: [CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1],
      screenIntent: INTENT,
    });
    const legacyView = HelloC2SSchema.deserialize(encoded);
    expect(legacyView).toEqual(LEGACY);
    expect(encoded.byteLength).toBeGreaterThan(HelloC2SSchema.serialize(LEGACY).byteLength);
  });

  test('2.3.0 客户端 → 新网关：decodeHelloC2S 回退，不把尾部当成 intent', () => {
    const decoded = decodeHelloC2S(HelloC2SSchema.serialize(LEGACY));
    expect(decoded.screenIntent).toBeNull();
    expect(decoded.clientCapabilities).toEqual([]);
  });

  test('只有能力位、没有 intent：option 编码为 None，旧 schema 仍能解', () => {
    const encoded = encodeHelloC2S({
      ...LEGACY,
      clientCapabilities: [CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1],
      screenIntent: null,
    });
    expect(HelloC2SWithIntentSchema.deserialize(encoded).screenIntent).toBeNull();
    expect(HelloC2SSchema.deserialize(encoded)).toEqual(LEGACY);
    expect(decodeHelloC2S(encoded).screenIntent).toBeNull();
    expect(decodeHelloC2S(encoded).clientCapabilities).toEqual([
      CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1,
    ]);
  });

  test('screenIntent 字段顺序与 RequestScreenIntent 相同', () => {
    const encoded = encodeHelloC2S({
      ...LEGACY,
      clientCapabilities: [CLIENT_CAPABILITY_HELLO_SCREEN_INTENT_V1],
      screenIntent: { ...INTENT, windowId: '@1' },
    });
    const decoded = HelloC2SWithIntentSchema.deserialize(encoded);
    expect(decoded.screenIntent).toEqual({ ...INTENT, windowId: '@1' });
  });
});
