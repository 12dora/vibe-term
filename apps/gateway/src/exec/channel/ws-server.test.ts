import { afterEach, describe, expect, test } from 'bun:test';
import {
  EcKind,
  type ExecExit,
  type ExecHello,
  type ExecReady,
  FrameDecoder,
  decodeJson,
  encodeJsonFrame,
} from '@vibeterm/shared/exec-channel';
import { attachExecChannelWith } from './connection';
import { realClock } from './deps';
import { spawnExecProcess } from './process';
import { testDevice } from './process-test-util';
import { resetExecRegistryForTests } from './registry';
import { createExecWebSocketHandlers } from './ws-handlers';
import { authenticateOpenExecUpgrade, handleExecWsUpgrade, isExecWsPath } from './ws-upgrade';

const handlers = createExecWebSocketHandlers((transport, auth) =>
  attachExecChannelWith(transport, auth, {
    spawn: spawnExecProcess,
    resolveDevice: () => testDevice(),
    clock: realClock,
    maxSessions: 8,
    credentialValid: () => true,
  })
);

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const server of servers.splice(0)) server.stop(true);
  resetExecRegistryForTests();
});

function startServer() {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, bunServer) {
      const path = new URL(req.url).pathname;
      if (isExecWsPath(path)) {
        return handleExecWsUpgrade(req, bunServer, authenticateOpenExecUpgrade);
      }
      return new Response('nope', { status: 404 });
    },
    websocket: {
      open: (ws) => handlers.open(ws),
      message: (ws, message) => handlers.message(ws, message),
      drain: (ws) => handlers.drain(ws),
      close: (ws) => handlers.close(ws),
    },
  });
  servers.push(server);
  return server;
}

async function connect(server: ReturnType<typeof Bun.serve>, path = '/api/exec/ws') {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`);
  ws.binaryType = 'arraybuffer';
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
  return ws;
}

function frames(ws: WebSocket) {
  const decoder = new FrameDecoder();
  const queue: Array<{ kind: number; payload: Uint8Array }> = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener('message', (event) => {
    queue.push(...decoder.push(new Uint8Array(event.data as ArrayBuffer)));
    for (const wake of waiters.splice(0)) wake();
  });
  return {
    async next(): Promise<{ kind: number; payload: Uint8Array }> {
      while (queue.length === 0) await new Promise<void>((resolve) => waiters.push(resolve));
      return queue.shift() as { kind: number; payload: Uint8Array };
    },
  };
}

function hello(script: string): Uint8Array {
  const msg: ExecHello = {
    v: 1,
    op: 'open',
    spec: { command: { kind: 'argv', argv: ['/bin/sh', '-c', script] }, stdin: false },
  };
  return encodeJsonFrame(EcKind.HELLO, msg);
}

describe('exec websocket end to end', () => {
  test('runs a command and streams READY, STDOUT, STDERR and EXIT', async () => {
    const server = startServer();
    const ws = await connect(server);
    const incoming = frames(ws);
    ws.send(hello('printf hi; printf err >&2; exit 3'));

    const ready = await incoming.next();
    expect(ready.kind).toBe(EcKind.READY);
    expect(decodeJson<ExecReady>(ready.payload).resumed).toBe(false);

    let stdout = '';
    let stderr = '';
    let exit: ExecExit | null = null;
    while (exit === null) {
      const frame = await incoming.next();
      if (frame.kind === EcKind.STDOUT) stdout += new TextDecoder().decode(frame.payload);
      else if (frame.kind === EcKind.STDERR) stderr += new TextDecoder().decode(frame.payload);
      else if (frame.kind === EcKind.EXIT) exit = decodeJson<ExecExit>(frame.payload);
    }
    expect(stdout).toBe('hi');
    expect(stderr).toBe('err');
    expect(exit.code).toBe(3);
    expect(exit.reason).toBe('exit');
  });

  test('serves the /n/self alias path', async () => {
    const server = startServer();
    const ws = await connect(server, '/n/self/api/exec/ws');
    const incoming = frames(ws);
    ws.send(hello('exit 0'));
    expect((await incoming.next()).kind).toBe(EcKind.READY);
  });

  test('a text message closes the socket with 4400', async () => {
    const server = startServer();
    const ws = await connect(server);
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener('close', (event) => resolve(event.code), { once: true })
    );
    ws.send('not binary');
    expect(await closed).toBe(4400);
  });

  test('a non-upgrade request gets 400 upgrade_required', async () => {
    const server = startServer();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/exec/ws`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'upgrade_required' });
  });
});
