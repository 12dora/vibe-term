// HELLO_C2S 2.3.0 线格 + 尾部可选 screenIntent。
// zorsh 忽略尾部多余字节：新客户端多写的字段会被 2.3.0 网关丢掉；
// 缺尾部字段的旧 HELLO 用 HelloC2SSchema 回退解码。

import { b } from '@zorsh/zorsh';

import { ERROR_PAYLOAD_DECODE_FAILED, WsBorshError } from './errors';
import { HelloC2SSchema } from './schema';

export const HelloScreenIntentSchema = b.struct({
  requestId: b.bytes(16),
  deviceId: b.string(),
  windowId: b.option(b.string()),
  paneId: b.option(b.string()),
  byteLimit: b.u32(),
});

export const HelloC2SWithIntentSchema = b.struct({
  clientImpl: b.string(),
  clientVersion: b.string(),
  maxFrameBytes: b.u32(),
  supportsCompression: b.bool(),
  supportsDiffSnapshot: b.bool(),
  clientCapabilities: b.vec(b.string()),
  screenIntent: b.option(HelloScreenIntentSchema),
});

export type HelloScreenIntent = {
  requestId: Uint8Array;
  deviceId: string;
  windowId: string | null;
  paneId: string | null;
  byteLimit: number;
};

export type HelloC2S = {
  clientImpl: string;
  clientVersion: string;
  maxFrameBytes: number;
  supportsCompression: boolean;
  supportsDiffSnapshot: boolean;
  clientCapabilities: string[];
  screenIntent: HelloScreenIntent | null;
};

function helloBase(data: HelloC2S) {
  return {
    clientImpl: data.clientImpl,
    clientVersion: data.clientVersion,
    maxFrameBytes: data.maxFrameBytes,
    supportsCompression: data.supportsCompression,
    supportsDiffSnapshot: data.supportsDiffSnapshot,
  };
}

export function encodeHelloC2S(data: HelloC2S): Uint8Array {
  const base = helloBase(data);
  if (data.clientCapabilities.length === 0 && data.screenIntent == null) {
    return HelloC2SSchema.serialize(base);
  }
  return HelloC2SWithIntentSchema.serialize({
    ...base,
    clientCapabilities: data.clientCapabilities,
    screenIntent: data.screenIntent,
  });
}

export function decodeHelloC2S(bytes: Uint8Array): HelloC2S {
  try {
    const decoded = HelloC2SWithIntentSchema.deserialize(bytes);
    return {
      ...decoded,
      clientCapabilities: decoded.clientCapabilities,
      screenIntent: decoded.screenIntent,
    };
  } catch {
    try {
      const legacy = HelloC2SSchema.deserialize(bytes);
      return { ...legacy, clientCapabilities: [], screenIntent: null };
    } catch (err) {
      throw new WsBorshError(
        ERROR_PAYLOAD_DECODE_FAILED,
        false,
        err instanceof Error ? err.message : 'HELLO payload decode failed'
      );
    }
  }
}

export function helloC2SHasCapability(hello: HelloC2S, capability: string): boolean {
  return hello.clientCapabilities.includes(capability);
}
