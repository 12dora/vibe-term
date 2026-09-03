// Gateway Borsh 集成测试

import { describe, expect, it } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { createGatewaySession } from '../test-helpers';
import { createBorshSessionState, encodePayloadFrames } from './codec-borsh';
import { sessionStateStore } from './session-state';

describe('borsh codec', () => {
  it('应该创建 BorshSessionState', () => {
    const state = createBorshSessionState();
    expect(state.negotiated).toBe(false);
    expect(state.clientImpl).toBeNull();
    expect(state.clientVersion).toBeNull();
    expect(state.maxFrameBytes).toBe(wsBorsh.DEFAULT_MAX_FRAME_BYTES);
    expect(state.seqGen()).toBe(1);
    expect(state.seqGen()).toBe(2);
  });

  it('应该编码和解码 HELLO', () => {
    const state = createBorshSessionState();
    const seq = state.seqGen();

    const helloS2C = {
      serverImpl: 'tmex-gateway',
      serverVersion: '0.1.0',
      selectedVersion: 1,
      maxFrameBytes: 65536,
      heartbeatIntervalMs: 15000,
      capabilities: ['borsh-v1'],
    };

    const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, helloS2C);
    const encoded = wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_S2C, payload, seq);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const envelope = wsBorsh.decodeEnvelope(encoded);
    expect(envelope.kind).toBe(wsBorsh.KIND_HELLO_S2C);
    expect(envelope.seq).toBe(seq);
    expect(wsBorsh.decodePayload(wsBorsh.schema.HelloS2CSchema, envelope.payload)).toEqual(
      helloS2C
    );
  });

  it('应该编码和解码 PING/PONG', () => {
    const state = createBorshSessionState();
    const seq = state.seqGen();

    const ping = {
      nonce: 12345,
      timeMs: BigInt(Date.now()),
    };

    // 模拟客户端发送 PING
    const pingPayload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, ping);
    const pingEnvelope = wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, pingPayload, 1);

    const decodedPing = wsBorsh.decodePayload(
      wsBorsh.schema.PingPongSchema,
      wsBorsh.decodeEnvelope(pingEnvelope).payload
    );
    expect(decodedPing.nonce).toBe(ping.nonce);

    const pongPayload = wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, {
      nonce: decodedPing.nonce,
      timeMs: BigInt(Date.now()),
    });
    const pong = wsBorsh.encodeEnvelope(wsBorsh.KIND_PONG, pongPayload, seq);

    const pongEnvelope = wsBorsh.decodeEnvelope(pong);
    expect(pongEnvelope.kind).toBe(wsBorsh.KIND_PONG);
  });

  it('应该编码 DEVICE_CONNECTED', () => {
    const state = createBorshSessionState();
    const seq = state.seqGen();

    const payload = wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectedSchema, {
      deviceId: 'device-1',
    });
    const connected = wsBorsh.encodeEnvelope(wsBorsh.KIND_DEVICE_CONNECTED, payload, seq);
    const envelope = wsBorsh.decodeEnvelope(connected);

    expect(envelope.kind).toBe(wsBorsh.KIND_DEVICE_CONNECTED);
    expect(wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectedSchema, envelope.payload)).toEqual({
      deviceId: 'device-1',
    });
  });

  it('unchunked encodePayloadFrames 使用原始 seq 且只消耗一次', () => {
    let seq = 10;
    const frames = encodePayloadFrames(
      wsBorsh.KIND_PONG,
      new Uint8Array([1, 2, 3]),
      () => seq++,
      1024
    );
    expect(frames.length).toBe(1);
    const unchunked = frames[0];
    expect(unchunked).toBeInstanceOf(Uint8Array);
    if (!unchunked) return;
    expect(wsBorsh.decodeEnvelope(unchunked).seq).toBe(10);
    expect(seq).toBe(11);
  });

  it('chunked encodePayloadFrames 把原始 seq 写入 chunk，后续 seq 用于各帧', () => {
    let seq = 5;
    const frames = encodePayloadFrames(
      wsBorsh.KIND_CANONICAL_EVENT,
      new Uint8Array(200),
      () => seq++,
      64
    );
    expect(frames.length).toBeGreaterThan(1);
    const firstFrame = frames[0];
    expect(firstFrame).toBeInstanceOf(Uint8Array);
    if (!firstFrame) return;
    const first = wsBorsh.decodeEnvelope(firstFrame);
    expect(first.kind).toBe(wsBorsh.KIND_CHUNK);
    expect(first.seq).toBe(6);
    const chunk = wsBorsh.decodeChunk(first.payload);
    expect(chunk.originalSeq).toBe(5);
    expect(chunk.originalKind).toBe(wsBorsh.KIND_CANONICAL_EVENT);
  });
});

describe('session state store', () => {
  it('应该创建 session state', () => {
    const session = createGatewaySession();
    const state = sessionStateStore.create(session);

    expect(state).toBeDefined();
    expect(state.wsConnection.state).toBe('IDLE');
    expect(state.deviceConnections.size).toBe(0);
    expect(state.wsConnection.seq).toBe(0);
  });

  it('应该管理设备连接状态', () => {
    const session = createGatewaySession();
    sessionStateStore.create(session);

    const deviceId = 'device-1';

    const ctx = sessionStateStore.getOrCreateDeviceConnection(session, deviceId);
    expect(ctx).toBeDefined();
    expect(ctx?.state).toBe('DETACHED');

    const transitioned = sessionStateStore.transitionDeviceState(session, deviceId, 'CONNECTING');
    expect(transitioned).toBe(true);

    const updated = sessionStateStore.getOrCreateDeviceConnection(session, deviceId);
    expect(updated?.state).toBe('CONNECTING');
  });

  it('两套 seq 在 attach 第二载体后都不重置', () => {
    const session = createGatewaySession({ session: true });
    expect(session.borshState.seqGen()).toBe(1);
    expect(session.borshState.seqGen()).toBe(2);
    session.state.wsConnection.seq = 9;

    const extra = createGatewaySession().primary;
    session.attachCarrier(extra, 'direct');
    session.switchActiveCarrier(extra);

    expect(session.borshState.seqGen()).toBe(3);
    expect(session.state.wsConnection.seq).toBe(9);
    expect(sessionStateStore.incrementSeq(session)).toBe(10);
  });
});
