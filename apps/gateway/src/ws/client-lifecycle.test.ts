import { describe, expect, test } from 'bun:test';
import { sessionStateStore } from './borsh/session-state';
import { handleClientDrain, handleUpgrade, openClient } from './client-lifecycle';
import { WebSocketServer } from './index';
import { createBorshTestWs } from './test-helpers';

describe('handleUpgrade', () => {
  test('rejects non-/ws paths without calling upgrade', () => {
    let upgradeCalls = 0;
    const bunServer = {
      upgrade() {
        upgradeCalls += 1;
        return true;
      },
    };
    const result = handleUpgrade(new Request('http://localhost/api'), bunServer);
    expect(result).toBe(false);
    expect(upgradeCalls).toBe(0);
  });

  test('returns undefined when /ws upgrade succeeds', () => {
    const bunServer = {
      upgrade() {
        return true;
      },
    };
    const result = handleUpgrade(new Request('http://localhost/ws'), bunServer);
    expect(result).toBeUndefined();
  });

  test('returns HTTP 500 when /ws upgrade fails', async () => {
    const bunServer = {
      upgrade() {
        return false;
      },
    };
    const result = handleUpgrade(new Request('http://localhost/ws?x=1'), bunServer);
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(500);
    expect(await result.text()).toBe('Upgrade failed');
  });
});

describe('openClient', () => {
  test('registers the socket in connectedClients and session state', () => {
    const connectedClients = new Set<ReturnType<typeof createBorshTestWs>>();
    const ws = createBorshTestWs();
    openClient(ws, connectedClients);
    expect(connectedClients.has(ws)).toBe(true);
    expect(sessionStateStore.get(ws)).toBeDefined();
    sessionStateStore.cleanup(ws);
  });
});

describe('handleClientDrain', () => {
  test('forwards drain to a canonical session when one exists', () => {
    let drained = 0;
    const ws = createBorshTestWs();
    const sessions = new Map([
      [
        ws,
        {
          onDrain() {
            drained += 1;
          },
        },
      ],
    ]);
    handleClientDrain(ws, sessions);
    expect(drained).toBe(1);
  });
});

describe('WebSocketServer closeAll and handleClose', () => {
  test('handleUpgrade on the server class rejects non-/ws paths', () => {
    const server = new WebSocketServer();
    let upgradeCalls = 0;
    const bunServer = {
      upgrade() {
        upgradeCalls += 1;
        return true;
      },
    };
    expect(server.handleUpgrade(new Request('http://localhost/api'), bunServer)).toBe(false);
    expect(upgradeCalls).toBe(0);
  });
  test('handleClose drops the client from connectedClients', () => {
    const server = new WebSocketServer();
    const ws = createBorshTestWs();
    server.handleOpen(ws);
    expect(server.connectedClients.has(ws)).toBe(true);
    server.handleClose(ws);
    expect(server.connectedClients.has(ws)).toBe(false);
  });
});
