import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import { encodeMeshPing, isMeshPong } from './mesh-ws-ping';

describe('mesh-ws-ping', () => {
  test('PING 帧可解；PONG 才被 isMeshPong 认出来', () => {
    const ping = encodeMeshPing(7, 1_000, 3);
    const env = wsBorsh.decodeEnvelope(ping);
    expect(env.kind).toBe(wsBorsh.KIND_PING);
    expect(wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, env.payload).nonce).toBe(7);
    expect(isMeshPong(ping)).toBe(false);

    const pong = wsBorsh.encodeEnvelope(wsBorsh.KIND_PONG, env.payload, 4);
    expect(isMeshPong(pong)).toBe(true);
  });

  test('畸形字节不是 PONG', () => {
    expect(isMeshPong(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
