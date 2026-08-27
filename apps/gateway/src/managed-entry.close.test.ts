import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_RESTART_CLOSE_CODE,
  RUNTIME_RESTART_CLOSE_REASON,
  closeRuntimeWebSockets,
} from './managed-entry';
import { WebSocketServer } from './ws';
import type { GatewaySession } from './ws/gateway-session';
import { createFakeCarrier, createGatewaySession } from './ws/test-helpers';

describe('managed-entry restart close', () => {
  test('restart while direct is active closes both carriers via closeSession', () => {
    const server = new WebSocketServer();
    const session = createGatewaySession();
    const direct = createFakeCarrier();
    server.handleOpen(session);
    session.attachCarrier(direct, 'direct');
    session.switchActiveCarrier(direct);
    server.getOrCreateCanonicalSession(session);

    const runtime = {
      handleRequest: () => new Response('ok'),
      websocket: {
        backpressureLimit: 1,
        closeOnBackpressureLimit: true,
        open() {},
        message() {},
        drain() {},
        close() {
          throw new Error('restart must not forge a ServerWebSocket');
        },
        closeSession(target: GatewaySession, code: number, reason: string) {
          server.closeSession(target, code, reason);
        },
      },
      onRestartRequested() {},
      async stop() {},
    };
    const socketOwners = new Map<GatewaySession, typeof runtime>([[session, runtime]]);

    const error = closeRuntimeWebSockets(socketOwners, runtime);

    expect(error).toBeUndefined();
    expect(socketOwners.size).toBe(0);
    expect(session.closed).toBe(true);
    expect(session.direct).toBeNull();
    expect((session.primary as ReturnType<typeof createFakeCarrier>).closeCalls).toEqual([
      { code: RUNTIME_RESTART_CLOSE_CODE, reason: RUNTIME_RESTART_CLOSE_REASON },
    ]);
    expect(direct.closeCalls).toEqual([
      { code: RUNTIME_RESTART_CLOSE_CODE, reason: RUNTIME_RESTART_CLOSE_REASON },
    ]);
    expect(server.connectedClients.has(session)).toBe(false);
    expect(server.canonicalSessions.has(session)).toBe(false);
  });
});
