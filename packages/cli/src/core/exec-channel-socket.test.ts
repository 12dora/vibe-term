import { afterEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { generateEd25519KeyPair, popTargetFromUrl, verifyPop } from '@vibeterm/shared/auth';
import { POP_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { EXIT_AUTH } from './errors';
import { cleanupContexts, testCtx } from './exec-channel-fakes';
import {
  EXEC_CLOSE_UNAUTHORIZED,
  connectWsExecSocket,
  execSocketTarget,
} from './exec-channel-socket';
import { loginRequiredError } from './http';
import { POP_ERROR_MESSAGE_EN } from './session-pop';

afterEach(cleanupContexts);

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('execSocketTarget PoP', () => {
  test('v1 sessions send no pop header', async () => {
    const { ctx } = await testCtx();
    ctx.http.jar.set('self', 'sid-1', 0);
    const target = execSocketTarget(ctx, 'self');
    expect(target.headers.cookie).toContain('vibeterm_s_self=sid-1');
    expect(target.headers[POP_HEADER]).toBeUndefined();
  });

  test('adds a verifiable x-vibeterm-pop header when a key exists', async () => {
    const { ctx } = await testCtx();
    const pair = generateEd25519KeyPair();
    ctx.http.jar.set('self', 'sid-1', 0);
    ctx.http.jar.setPopKey('self', { sessSk: pair.secretKey, sessPk: pair.publicKey });
    const target = execSocketTarget(ctx, 'self');
    expect(target.headers[POP_HEADER]).toBeTruthy();
    expect(
      verifyPop(pair.publicKey, target.headers[POP_HEADER], popTargetFromUrl('GET', target.url)).ok
    ).toBe(true);
  });

  test('signs the target node’s key, not another node’s', async () => {
    const { ctx } = await testCtx();
    const node = 'a'.repeat(32);
    const keySelf = generateEd25519KeyPair();
    const keyNode = generateEd25519KeyPair();
    ctx.http.jar.set('self', 'sid-self', 0);
    ctx.http.jar.set(node, 'sid-node', 0);
    ctx.http.jar.setPopKey('self', { sessSk: keySelf.secretKey, sessPk: keySelf.publicKey });
    ctx.http.jar.setPopKey(node, { sessSk: keyNode.secretKey, sessPk: keyNode.publicKey });
    const target = execSocketTarget(ctx, node);
    expect(
      verifyPop(keyNode.publicKey, target.headers[POP_HEADER], popTargetFromUrl('GET', target.url))
        .ok
    ).toBe(true);
    expect(
      verifyPop(keySelf.publicKey, target.headers[POP_HEADER], popTargetFromUrl('GET', target.url))
        .ok
    ).toBe(false);
  });
});

describe('exec WS PoP failures', () => {
  test('local upgrade HTTP 401 JSON is the same PoP error; exec close code stays 4401', () => {
    expect(EXEC_CLOSE_UNAUTHORIZED).toBe(4401);
    const error = loginRequiredError('self', JSON.stringify({ code: 'POP_REQUIRED' }));
    expect(error.code).toBe('POP_REQUIRED');
    expect(error.message).toBe(POP_ERROR_MESSAGE_EN);
    expect(error.message).not.toContain('not authenticated');
    expect(error.exitCode).toBe(EXIT_AUTH);
  });

  test('entry exec WS 4401 POP_INVALID maps to the PoP error, not login required', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (socket: WsSocket) => {
      socket.close(4401, 'POP_INVALID');
    });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    servers.push({
      close: () =>
        new Promise<void>((resolve) => {
          for (const client of wss.clients) client.terminate();
          const timer = setTimeout(resolve, 200);
          wss.close(() => {
            clearTimeout(timer);
            resolve();
          });
        }),
    });
    const { port } = wss.address() as AddressInfo;
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      const socket = connectWsExecSocket({
        url: `ws://127.0.0.1:${port}/api/exec/ws`,
        headers: {},
        tls: {},
        handshakeTimeoutMs: 2000,
      });
      socket.onclose = (code, reason) => resolve({ code, reason });
    });
    expect(closed.code).toBe(EXEC_CLOSE_UNAUTHORIZED);
    expect(closed.reason).toBe('POP_INVALID');
    const error = loginRequiredError('self', closed.reason);
    expect(error.code).toBe('POP_INVALID');
    expect(error.message).toBe(POP_ERROR_MESSAGE_EN);
    expect(error.message).not.toContain('not authenticated');
    expect(error.exitCode).toBe(EXIT_AUTH);
  });
});
