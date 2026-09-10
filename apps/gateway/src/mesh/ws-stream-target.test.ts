import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import type { NodeSessionStore, NodeSessionVerifyReason } from '../auth/node-session-store';
import type { WebSocketServer } from '../ws';
import type { GatewaySession } from '../ws/gateway-session';
import { WS_CLOSE_LOGIN_REQUIRED, WS_SESSION_VERIFY_MS } from './mesh-deps';
import { CID_MAX_LENGTH } from './mesh-session-registry';
import { decodeTerminalStreamClose } from './stream-close-code';
import {
  type GatewaySessionClose,
  WS_CLOSE_STREAM_TEARDOWN,
  acceptWsStream,
  openWsStream,
} from './ws-stream-target';

type CloseRecord = { code?: number; reason?: string };

function fakeWsServer(onDecoded?: () => void): {
  server: WebSocketServer;
  sessionCloses: CloseRecord[];
} {
  const sessionCloses: CloseRecord[] = [];
  const session = { closed: false } as unknown as GatewaySession;
  const server = {
    attachStreamSession: () => ({
      session,
      onMessage: () => {},
      onDecodedEnvelope: () => onDecoded?.(),
      onClose: (code?: number, reason?: string) => {
        sessionCloses.push({ code, reason });
      },
    }),
  } as unknown as WebSocketServer;
  return { server, sessionCloses };
}

function countingStore(
  plan: () => NodeSessionVerifyReason | null,
  expiry?: (now: number) => { expiresAt: number; hardExpiresAt: number }
): {
  store: NodeSessionStore;
  calls: number[];
} {
  const calls: number[] = [];
  const store = {
    verify: (_sid: string, input: { viaNodeId: string; now: number }) => {
      calls.push(input.now);
      const reason = plan();
      return reason
        ? { ok: false as const, reason }
        : {
            ok: true as const,
            session: { userId: 'user-1', ...(expiry ? expiry(input.now) : {}) },
          };
    },
  } as unknown as NodeSessionStore;
  return { store, calls };
}

const HELLO = wsBorsh.encodeEnvelope(
  wsBorsh.KIND_HELLO_C2S,
  wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
    clientImpl: 'ws-stream-target-test',
    clientVersion: '2.0.0',
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    supportsCompression: false,
    supportsDiffSnapshot: false,
  }),
  1
);

async function attachStream(opts: {
  store: NodeSessionStore;
  server: WebSocketServer;
  now?: () => number;
}): Promise<{
  opened: Awaited<ReturnType<typeof openWsStream>>;
  registryCloses: Array<GatewaySessionClose | undefined>;
}> {
  const [a, b] = createInMemoryLinkPair();
  const registryCloses: Array<GatewaySessionClose | undefined> = [];
  b.onStream((stream) => {
    void acceptWsStream(stream, {
      peerNodeId: 'entry-1',
      sessionStore: opts.store,
      wsServer: opts.server,
      ...(opts.now ? { now: opts.now } : {}),
      onGatewaySession: () => true,
      onGatewaySessionClose: (_session, close) => {
        registryCloses.push(close);
      },
    });
  });
  const opened = await openWsStream(a, 'sid-1', 'tab-1');
  return { opened, registryCloses };
}

describe('mesh ws 流的拆解语义', () => {
  test('浏览器侧收流（end）不再报成 4401，会话按非终止码关闭', async () => {
    const { server, sessionCloses } = fakeWsServer();
    const { store } = countingStore(() => null);
    const { opened, registryCloses } = await attachStream({ store, server });
    await opened.send(HELLO);
    await Bun.sleep(10);
    opened.close();
    const closed = await opened.stream.closed;
    expect(closed.reason).toBe('end');
    expect(decodeTerminalStreamClose(closed.message)).toBeNull();
    expect(registryCloses[0]).toEqual({ code: WS_CLOSE_STREAM_TEARDOWN, reason: 'end' });
    expect(sessionCloses[0]).toEqual({ code: WS_CLOSE_STREAM_TEARDOWN, reason: 'end' });
  });

  test('读侧异常（ws-read-failed）用非终止码 RST，真实原因随 RST 带走', async () => {
    const { server, sessionCloses } = fakeWsServer(() => {
      throw new Error('boom');
    });
    const { store } = countingStore(() => null);
    const { opened, registryCloses } = await attachStream({ store, server });
    await opened.send(HELLO);
    const closed = await opened.stream.closed;
    expect(closed.reason).toBe('rst');
    expect(closed.message).toBe('ws-read-failed');
    expect(decodeTerminalStreamClose(closed.message)).toBeNull();
    expect(registryCloses[0]).toEqual({
      code: WS_CLOSE_STREAM_TEARDOWN,
      reason: 'ws-read-failed',
    });
    expect(sessionCloses[0]?.code).toBe(WS_CLOSE_STREAM_TEARDOWN);
  });

  test('对端 RST（链路抖动）拆流同样不是 4401', async () => {
    const { server } = fakeWsServer();
    const { store } = countingStore(() => null);
    const { opened, registryCloses } = await attachStream({ store, server });
    await opened.send(HELLO);
    await Bun.sleep(10);
    opened.stream.reset('link-gone');
    await Bun.sleep(20);
    expect(registryCloses[0]).toEqual({ code: WS_CLOSE_STREAM_TEARDOWN, reason: 'peer-rst' });
  });

  test('复验判定 expired / via_mismatch 才发 4401 终止码，并带上真实原因', async () => {
    for (const reason of ['expired', 'via_mismatch'] as NodeSessionVerifyReason[]) {
      let now = 1_000;
      let first = true;
      const { server } = fakeWsServer();
      const { store } = countingStore(() => {
        if (first) {
          first = false;
          return null;
        }
        return reason;
      });
      const { opened, registryCloses } = await attachStream({ store, server, now: () => now });
      now += WS_SESSION_VERIFY_MS + 1;
      await opened.send(HELLO);
      const closed = await opened.stream.closed;
      expect(closed.reason).toBe('rst');
      expect(decodeTerminalStreamClose(closed.message)).toEqual({
        code: WS_CLOSE_LOGIN_REQUIRED,
        reason: `NODE_LOGIN_REQUIRED:${reason}`,
      });
      expect(registryCloses[0]?.code).toBe(WS_CLOSE_LOGIN_REQUIRED);
    }
  });

  test('复验按 WS_SESSION_VERIFY_MS 节流：窗口内多帧只压一次库', async () => {
    let now = 1_000;
    const { server } = fakeWsServer();
    const { store, calls } = countingStore(() => null);
    const { opened } = await attachStream({ store, server, now: () => now });
    for (let i = 0; i < 8; i += 1) {
      await opened.send(HELLO);
      now += 1_000;
    }
    await Bun.sleep(20);
    // 握手一次 + 第一帧一次；其余 7 帧都落在同一个复验窗口里。
    expect(calls.length).toBe(2);
    now += WS_SESSION_VERIFY_MS;
    await opened.send(HELLO);
    await Bun.sleep(20);
    expect(calls.length).toBe(3);
  });

  test('复验窗口不越过会话过期时刻：TTL 不会被节流拖软', async () => {
    let now = 1_000;
    const expiresAt = now + 30_000;
    const { server } = fakeWsServer();
    const { store, calls } = countingStore(
      () => (now >= expiresAt ? 'expired' : null),
      () => ({ expiresAt, hardExpiresAt: expiresAt + 1e9 })
    );
    const { opened } = await attachStream({ store, server, now: () => now });
    await opened.send(HELLO);
    await Bun.sleep(20);
    // 握手 + 第一帧；下一次复验被会话过期时刻拉到 30 s 后，而不是 5 分钟后。
    expect(calls.length).toBe(2);
    now += 29_000;
    await opened.send(HELLO);
    await Bun.sleep(20);
    expect(calls.length).toBe(2);
    now += 2_000;
    await opened.send(HELLO);
    const closed = await opened.stream.closed;
    expect(decodeTerminalStreamClose(closed.message)).toEqual({
      code: WS_CLOSE_LOGIN_REQUIRED,
      reason: 'NODE_LOGIN_REQUIRED:expired',
    });
  });

  test('cid 里的控制字符与超长内容被净化后才进日志与注册表', async () => {
    const { server } = fakeWsServer();
    const { store } = countingStore(() => null);
    const [a, b] = createInMemoryLinkPair();
    const seen: Array<string | undefined> = [];
    b.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: store,
        wsServer: server,
        onGatewaySession: (_session, auth) => {
          seen.push(auth.cid);
          return true;
        },
        onGatewaySessionClose: () => {},
      });
    });
    const opened = await openWsStream(a, 'sid-1', `tab\n[mesh] forged log line ${'x'.repeat(200)}`);
    await opened.send(HELLO);
    await Bun.sleep(20);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`tabmeshforgedlogline${'x'.repeat(44)}`);
    expect(seen[0]).not.toContain('\n');
    expect((seen[0] as string).length).toBe(CID_MAX_LENGTH);
    opened.close();
  });

  test('握手就鉴权失败时用 4401 终止码 RST，入口不再空转 failover', async () => {
    const { server } = fakeWsServer();
    const { store } = countingStore(() => 'unknown');
    const { opened } = await attachStream({ store, server });
    const closed = await opened.stream.closed;
    expect(closed.reason).toBe('rst');
    expect(decodeTerminalStreamClose(closed.message)).toEqual({
      code: WS_CLOSE_LOGIN_REQUIRED,
      reason: 'NODE_LOGIN_REQUIRED:unknown',
    });
  });
});

describe('真实 WebSocketServer + teardownBinding 形状的注册表', () => {
  /** 与 mesh-runtime.teardownBinding 同形状：拿到什么关闭码就用什么，缺省才是 4401。 */
  function bindingRegistry(server: WebSocketServer) {
    return (session: GatewaySession, close?: GatewaySessionClose) => {
      if (session.closed) return;
      server.closeSession(
        session,
        close?.code ?? WS_CLOSE_LOGIN_REQUIRED,
        close?.reason ?? 'NODE_LOGIN_REQUIRED'
      );
    };
  }

  async function attach(store: NodeSessionStore, now?: () => number) {
    const { WebSocketServer } = await import('../ws');
    const server = new WebSocketServer();
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: store,
        wsServer: server,
        ...(now ? { now } : {}),
        onGatewaySession: () => true,
        onGatewaySessionClose: bindingRegistry(server),
      });
    });
    return openWsStream(a, 'sid-1', 'tab-1');
  }

  test('浏览器收流时目标不再把会话关成 4401', async () => {
    const { store } = countingStore(() => null);
    const opened = await attach(store);
    await opened.send(HELLO);
    await Bun.sleep(20);
    opened.close();
    const closed = await opened.stream.closed;
    expect(closed.reason).toBe('end');
    expect(decodeTerminalStreamClose(closed.message)).toBeNull();
  });

  test('复验失败时目标仍把会话关成 4401', async () => {
    let now = 1_000;
    let first = true;
    const { store } = countingStore(() => {
      if (first) {
        first = false;
        return null;
      }
      return 'revoked';
    });
    const opened = await attach(store, () => now);
    now += WS_SESSION_VERIFY_MS + 1;
    await opened.send(HELLO);
    const closed = await opened.stream.closed;
    expect(decodeTerminalStreamClose(closed.message)?.code).toBe(WS_CLOSE_LOGIN_REQUIRED);
  });
});
