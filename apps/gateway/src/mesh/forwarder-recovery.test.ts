import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import {
  LinkError,
  type LinkSession,
  type LinkStream,
  createInMemoryLinkPair,
} from '@vibeterm/shared/link';
import { openAdaptedWsStream } from './adapted-ws-stream';
import { Forwarder, takePendingForwardStream } from './forwarder';
import { setForwardLinkDeadlineMs } from './forwarder-deadline';
import { linkSessionClosed } from './forwarder-link-state';
import type { MeshServerWebSocket, PeerLinkProvider } from './mesh-deps';
import { MESH_VIA_SELF, setMeshRequestContext } from './mesh-deps';
import { jsonError } from './session-middleware';
import { openHttpStream } from './stream-targets';

const OTHER = 'bb'.repeat(16);
const NODE_ID = 'aa'.repeat(16);

function peersFor(
  getLink: PeerLinkProvider['getLink'],
  extra?: Partial<PeerLinkProvider>
): PeerLinkProvider {
  return {
    getLink,
    listReach: () => new Map(),
    onNodeEvent: () => () => {},
    transportOf: () => 'relay',
    rttOf: () => 20,
    ...extra,
  };
}

function forwarder(peers: PeerLinkProvider, log?: (line: string) => void): Forwarder {
  return new Forwarder({
    nodeId: NODE_ID,
    peers,
    streams: {
      openHttpStream: (link, open, body, signal) =>
        openHttpStream(link, { type: 'http', ...open }, body, signal, peers.rttOf?.('x') ?? 20),
      openWsStream: (link, auth, cid, share) => openAdaptedWsStream(link, auth, cid, share),
    },
    sleep: async () => {},
    log,
  });
}

describe('forward recovery', () => {
  test('stale-link on a closed session is not opened again', async () => {
    const [entry] = createInMemoryLinkPair();
    const [relay] = createInMemoryLinkPair();
    const seen: string[] = [];
    const fwd = new Forwarder({
      nodeId: NODE_ID,
      peers: peersFor(async () => ((await linkSessionClosed(entry)) ? relay : entry)),
      streams: {
        openHttpStream: async (link) => {
          seen.push(link === entry ? 'entry' : 'relay');
          if (link === entry) {
            entry.close('stale-link');
            throw new LinkError('rst', 'stale-link');
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
        openWsStream: async () => {
          throw new Error('unused');
        },
      },
      sleep: async () => {},
    });
    const res = (await fwd.handle(
      new Request(`http://localhost/n/${OTHER}/api/devices`, {
        headers: { cookie: `vibeterm_s_${OTHER}=sid` },
      }),
      { upgrade: () => true }
    )) as Response;
    expect(res.status).toBe(200);
    expect(seen).toEqual(['entry', 'relay']);
  });

  test('pending-measure still replays on the same open session', async () => {
    const [entry] = createInMemoryLinkPair();
    let opens = 0;
    const fwd = new Forwarder({
      nodeId: NODE_ID,
      peers: peersFor(async () => entry),
      streams: {
        openHttpStream: async () => {
          opens += 1;
          if (opens === 1) throw new LinkError('rst', 'pending-measure');
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
        openWsStream: async () => {
          throw new Error('unused');
        },
      },
      sleep: async () => {},
    });
    const res = (await fwd.handle(
      new Request(`http://localhost/n/${OTHER}/api/devices`, {
        headers: { cookie: `vibeterm_s_${OTHER}=sid` },
      }),
      { upgrade: () => true }
    )) as Response;
    expect(res.status).toBe(200);
    expect(opens).toBe(2);
    expect(await linkSessionClosed(entry)).toBe(false);
  });

  test('forwardInternalHttp replays a JSON POST once on pending-measure', async () => {
    let opens = 0;
    const fwd = new Forwarder({
      nodeId: NODE_ID,
      peers: peersFor(async () => ({}) as LinkSession),
      streams: {
        openHttpStream: async () => {
          opens += 1;
          if (opens === 1) throw new LinkError('rst', 'pending-measure');
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
        openWsStream: async () => {
          throw new Error('unused');
        },
      },
      sleep: async () => {},
    });
    const res = await fwd.forwardInternalHttp(OTHER, '/api/mesh-internal/notify', { ok: true });
    expect(res.status).toBe(200);
    expect(opens).toBe(2);
  });

  test('forwardInternalHttp getLink is bounded by the forward deadline', async () => {
    const fwd = new Forwarder({
      nodeId: NODE_ID,
      peers: peersFor(() => new Promise<LinkSession>(() => {})),
      streams: {
        openHttpStream: async () => new Response(null, { status: 200 }),
        openWsStream: async () => {
          throw new Error('unused');
        },
      },
      sleep: async () => {},
    });
    setForwardLinkDeadlineMs(40);
    try {
      const started = Date.now();
      const res = await fwd.forwardInternalHttp(OTHER, '/api/mesh-internal/x', {});
      expect(res.status).toBe(503);
      expect((await res.json()).reason).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      setForwardLinkDeadlineMs(0);
    }
  });

  test('send() === 0 closes the upstream mesh stream', async () => {
    const [entry, target] = createInMemoryLinkPair();
    let targetStream: LinkStream | null = null;
    let targetClosed = false;
    target.onStream((stream) => {
      targetStream = stream;
      void stream.closed.then(() => {
        targetClosed = true;
      });
      // 目标侧在读：入口 end() 后这里把发送方向也关掉，流才从两端的表里消失。
      void (async () => {
        const reader = stream.readable.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
          await stream.end();
        } catch {
          // RST 已经拆掉了
        }
      })();
    });
    const fwd = forwarder(peersFor(async () => entry));
    const ws = await attach(fwd, 'leak');
    await Bun.sleep(30);
    if (!targetStream) throw new Error('no target stream');
    ws.sendResult = 0;
    await (targetStream as LinkStream).write(new Uint8Array([1, 2, 3]));
    await Bun.sleep(30);
    expect(targetClosed).toBe(true);
    const stats = (entry as LinkSession & { stats?: () => { openStreams: number } }).stats?.();
    expect(stats?.openStreams ?? 0).toBe(0);
  });

  test('closePump does not start failover', async () => {
    const [entry, target] = createInMemoryLinkPair();
    target.onStream(() => {});
    let gets = 0;
    const logs: string[] = [];
    const fwd = forwarder(
      peersFor(async () => {
        gets += 1;
        return entry;
      }),
      (line) => logs.push(line)
    );
    const ws = await attach(fwd, 'cp');
    await Bun.sleep(30);
    const before = gets;
    const pumps = (
      fwd as unknown as {
        wsPumps: {
          closePump: (pump: unknown, info: { code?: number; reason?: string }) => void;
          pumps: Map<unknown, unknown>;
        };
      }
    ).wsPumps;
    const pump = pumps.pumps.get(ws);
    pumps.closePump(pump, { code: 1011, reason: 'forward-queue-overflow' });
    await Bun.sleep(30);
    expect(gets).toBe(before);
    expect(logs.some((line) => line.includes('failover_start'))).toBe(false);
  });

  test('no-HELLO pump over a slow RST closes within the dead-open cap', async () => {
    const [entry, target] = createInMemoryLinkPair();
    let opens = 0;
    target.onStream((stream) => {
      opens += 1;
      setTimeout(() => stream.reset('stale-link'), 300);
    });
    const logs: string[] = [];
    const fwd = new Forwarder({
      nodeId: NODE_ID,
      peers: peersFor(async () => entry, { transportOf: () => 'dc', rttOf: () => 300 }),
      streams: {
        openHttpStream: (link, open, body, signal) =>
          openHttpStream(link, { type: 'http', ...open }, body, signal, 300),
        openWsStream: (link, auth, cid, share) => openAdaptedWsStream(link, auth, cid, share),
      },
      log: (line) => logs.push(line),
    });
    const ws = await attach(fwd, 'slow');
    for (let i = 0; i < 80 && ws.closes.length === 0; i += 1) await Bun.sleep(50);
    expect(ws.closes[0]?.code).toBe(1011);
    expect(ws.closes[0]?.reason).toBe('failover-no-hello');
    expect(opens).toBeLessThanOrEqual(3);
    expect(logs.some((line) => line.includes('failover_done'))).toBe(false);
  }, 15_000);

  test('entry auth forward stamps client, user-agent and the real client IP', async () => {
    let headers: Record<string, string> = {};
    const fwd = new Forwarder({
      nodeId: NODE_ID,
      peers: peersFor(async () => ({}) as LinkSession),
      streams: {
        openHttpStream: async (_link, open) => {
          headers = open.headers;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
        openWsStream: async () => {
          throw new Error('unused');
        },
      },
      sleep: async () => {},
    });
    const req = new Request(`http://localhost/n/${OTHER}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'VibeTermTest/1',
        'x-vibeterm-client': 'web',
        'x-vibeterm-entry-client-ip': '1.2.3.4',
      },
      body: JSON.stringify({ login: 'x' }),
    });
    setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '203.0.113.8' });
    const res = (await fwd.handle(req, { upgrade: () => true })) as Response;
    expect(res.status).toBe(200);
    expect(headers['x-vibeterm-client']).toBe('web');
    expect(headers['user-agent']).toBe('VibeTermTest/1');
    expect(headers['x-vibeterm-entry-client-ip']).toBe('203.0.113.8');
  });

  test('gateForwardedAuth 429 does not forward', async () => {
    let opened = false;
    const fwd = new Forwarder({
      nodeId: NODE_ID,
      peers: peersFor(async () => ({}) as LinkSession),
      streams: {
        openHttpStream: async () => {
          opened = true;
          return new Response(null, { status: 200 });
        },
        openWsStream: async () => {
          throw new Error('unused');
        },
      },
      sleep: async () => {},
      authRateLimits: {
        consumeChallengeQuota: () => jsonError('RATE_LIMITED', 429, { retryAfterMs: 1500 }),
        gateLogin: () => null,
        recordLoginFailure: () => {},
        recordLoginSuccess: () => {},
      },
    });
    const req = new Request(`http://localhost/n/${OTHER}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'x-vibeterm-client': 'cli', 'user-agent': 'cli/1' },
    });
    setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '198.51.100.4' });
    const res = (await fwd.handle(req, { upgrade: () => true })) as Response;
    expect(res.status).toBe(429);
    expect(opened).toBe(false);
  });
});

type FakeSocket = MeshServerWebSocket & {
  sendResult: number;
  closes: Array<{ code?: number; reason?: string }>;
};

async function attach(fwd: Forwarder, cid: string): Promise<FakeSocket> {
  let data: { token?: string } | undefined;
  await fwd.handle(
    new Request(`http://localhost/n/${OTHER}/ws?cid=${cid}`, {
      headers: { cookie: `vibeterm_s_${OTHER}=sid` },
    }),
    {
      upgrade(_req: Request, opts?: { data?: unknown }) {
        data = opts?.data as { token?: string };
        return true;
      },
    }
  );
  const pending = takePendingForwardStream(data?.token);
  if (!pending) throw new Error('no pending');
  const socket = {
    data: data as never,
    sendResult: 10,
    closes: [] as Array<{ code?: number; reason?: string }>,
    send: () => socket.sendResult,
    close: (code?: number, reason?: string) => {
      socket.closes.push({ code, reason });
    },
  } as FakeSocket;
  fwd.attachForwardPump(socket, pending);
  return socket;
}
