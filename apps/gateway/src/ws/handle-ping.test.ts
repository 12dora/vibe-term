import { afterEach, describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import {
  GatewayPingMetrics,
  resetPingMetricsForTest,
  setPingMetricsForTest,
} from './gateway-metrics-log';
import { WebSocketServer } from './index';
import { createFakeCarrier, createGatewaySession } from './test-helpers';
import {
  GATEWAY_WS_PONG_BYPASS_BUFFERED_BYTES,
  gatewayWebSocketSendGuard,
} from './websocket-send-guard';

afterEach(() => {
  resetPingMetricsForTest();
});

function pingPayload(nonce = 42, timeMs = 99n): Uint8Array {
  return wsBorsh.encodePayload(wsBorsh.schema.PingPongSchema, { nonce, timeMs });
}

function decodePong(frame: Uint8Array): { nonce: number; timeMs: bigint } {
  const envelope = wsBorsh.decodeEnvelope(frame);
  expect(envelope.kind).toBe(wsBorsh.KIND_PONG);
  return wsBorsh.decodePayload(wsBorsh.schema.PingPongSchema, envelope.payload);
}

async function sendPing(
  server: WebSocketServer,
  ws: ReturnType<typeof createGatewaySession>,
  nonce = 42
): Promise<void> {
  ws.borshState.negotiated = true;
  await server.handleBorshMessage(ws, wsBorsh.KIND_PING, 1, pingPayload(nonce, 99n));
}

describe('handlePing PONG priority path', () => {
  test('echoes nonce and bypasses the shared send queue', async () => {
    const server = new WebSocketServer();
    const ws = createGatewaySession();
    server.handleOpen(ws);
    await sendPing(server, ws, 42);

    expect(ws.sent).toHaveLength(1);
    expect(decodePong(ws.sent[0] as Uint8Array)).toEqual({ nonce: 42, timeMs: 99n });
    server.closeSession(ws, 1000, 'ping cleanup');
  });

  test('still sends PONG while terminal output is backpressured and does not mark a gap', async () => {
    const sent: Uint8Array[] = [];
    let calls = 0;
    const carrier = createFakeCarrier({
      bufferedAmount: 16,
      send(bytes) {
        sent.push(bytes.slice());
        calls += 1;
        return calls === 1 ? 'backpressure' : 'sent';
      },
    });
    const server = new WebSocketServer();
    const ws = createGatewaySession({ carrier });
    server.handleOpen(ws);

    expect(gatewayWebSocketSendGuard.sendFrames(carrier, [new Uint8Array([1, 2, 3])])).toBe(false);
    expect(gatewayWebSocketSendGuard.isBackpressured(carrier)).toBe(true);

    await sendPing(server, ws, 7);
    expect(calls).toBe(2);
    expect(decodePong(sent[1] as Uint8Array).nonce).toBe(7);

    gatewayWebSocketSendGuard.handleDrain(carrier);
    expect(gatewayWebSocketSendGuard.isBackpressured(carrier)).toBe(false);
    expect(gatewayWebSocketSendGuard.sendFrames(carrier, [new Uint8Array([9])])).toBe(true);

    gatewayWebSocketSendGuard.forget(carrier);
    server.closeSession(ws, 1000, 'ping cleanup');
  });

  test('high buffered amount still sends PONG and counts as queued', async () => {
    const started = Date.now();
    const metrics = new GatewayPingMetrics(60_000, started);
    setPingMetricsForTest(metrics);

    const server = new WebSocketServer();
    const ws = createGatewaySession({
      carrier: createFakeCarrier({ bufferedAmount: GATEWAY_WS_PONG_BYPASS_BUFFERED_BYTES }),
    });
    server.handleOpen(ws);
    await sendPing(server, ws, 11);

    expect(ws.sent).toHaveLength(1);
    expect(decodePong(ws.sent[0] as Uint8Array).nonce).toBe(11);

    const snapshot = metrics.takeIfDue(started + 60_000);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.probes).toBe(1);
    expect(snapshot?.queued).toBe(1);
    expect(snapshot?.bypassed).toBe(0);
    expect(snapshot?.bufferedMaxBytes).toBe(GATEWAY_WS_PONG_BYPASS_BUFFERED_BYTES);

    server.closeSession(ws, 1000, 'ping cleanup');
  });

  test('low buffered amount counts as bypassed', async () => {
    const started = Date.now();
    const metrics = new GatewayPingMetrics(60_000, started);
    setPingMetricsForTest(metrics);

    const server = new WebSocketServer();
    const ws = createGatewaySession({
      carrier: createFakeCarrier({ bufferedAmount: 128 }),
    });
    server.handleOpen(ws);
    await sendPing(server, ws, 3);

    const snapshot = metrics.takeIfDue(started + 60_000);
    expect(snapshot?.probes).toBe(1);
    expect(snapshot?.bypassed).toBe(1);
    expect(snapshot?.queued).toBe(0);
    expect(snapshot?.bufferedMaxBytes).toBe(128);

    server.closeSession(ws, 1000, 'ping cleanup');
  });

  test('PONG follows the carrier the PING arrived on', () => {
    const server = new WebSocketServer();
    const primary = createFakeCarrier();
    const direct = createFakeCarrier();
    const session = createGatewaySession({ carrier: primary });
    server.handleOpen(session);
    session.attachCarrier(direct, 'direct');
    session.switchActiveCarrier(direct);
    session.borshState.negotiated = true;
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, pingPayload(5, 99n), 1);
    server.handleMessage({ data: { session, carrier: primary } } as never, Buffer.from(frame));
    expect(primary.sent).toHaveLength(1);
    expect(decodePong(primary.sent[0] as Uint8Array).nonce).toBe(5);
    expect(direct.sent).toHaveLength(0);
    server.closeSession(session, 1000, 'ping cleanup');
  });

  test('stream session PONG follows the mux carrier, not the active direct DC', () => {
    const server = new WebSocketServer();
    const primary = createFakeCarrier();
    const direct = createFakeCarrier();
    const attached = server.attachStreamSession(primary);
    const session = attached.session;
    session.attachCarrier(direct, 'direct');
    session.switchActiveCarrier(direct);
    session.borshState.negotiated = true;
    const frame = (nonce: number) =>
      wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, pingPayload(nonce, 1n), 1);
    attached.onDecodedEnvelope(wsBorsh.decodeEnvelope(frame(7)));
    attached.onMessage(frame(8));
    expect(primary.sent).toHaveLength(2);
    expect(direct.sent).toHaveLength(0);
    server.closeSession(session, 1000, 'ping cleanup');
  });

  test('deliverRtcInbound PONG follows the direct carrier while active is primary', () => {
    const server = new WebSocketServer();
    const primary = createFakeCarrier();
    const direct = createFakeCarrier();
    const session = createGatewaySession({ carrier: primary });
    server.handleOpen(session);
    session.attachCarrier(direct, 'direct');
    session.switchActiveCarrier(primary);
    session.borshState.negotiated = true;
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, pingPayload(9, 1n), 1);
    server.deliverRtcInbound(session, frame, direct);
    expect(direct.sent).toHaveLength(1);
    expect(primary.sent).toHaveLength(0);
    server.closeSession(session, 1000, 'ping cleanup');
  });
});
