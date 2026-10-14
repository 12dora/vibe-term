import { describe, expect, test } from 'bun:test';
import type { LinkSession } from '@vibeterm/shared/link';
import { FakeLinkStream } from '../exec/channel/test-link-stream';
import { FakePeers, FakeStreams, asResponse, bootMesh } from './auth-routes.test';
import { decodeJsonBytes } from './ctl';
import {
  type ExecForwardSocketData,
  execForwardCredential,
  execForwardWebsocket,
  isExecForwardSocket,
} from './forwarder-exec-upgrade';
import { MESH_EXEC_FORWARD_KIND } from './mesh-deps';
import { waitUntil } from './test-support';

const OTHER = 'bb'.repeat(16);
const EXEC_URL = `http://localhost/n/${OTHER}/api/exec/ws`;

const upgradeHeaders = (extra: Record<string, string> = {}) => ({
  upgrade: 'websocket',
  connection: 'Upgrade',
  ...extra,
});

function captureServer() {
  const captured: { data?: ExecForwardSocketData; calls: number } = { calls: 0 };
  return {
    captured,
    server: {
      upgrade(_req: Request, opts?: { data?: unknown }) {
        captured.calls += 1;
        captured.data = opts?.data as ExecForwardSocketData;
        return true;
      },
    },
  };
}

class FakeWs {
  readonly sent: Uint8Array[] = [];
  closed: { code?: number; reason?: string } | null = null;
  constructor(readonly data: ExecForwardSocketData) {}
  send(data: Uint8Array): number {
    this.sent.push(data);
    return 1;
  }
  close(code?: number, reason?: string): void {
    this.closed ??= { code, reason };
  }
  getBufferedAmount(): number {
    return 0;
  }
}

describe('execForwardCredential', () => {
  test('reads the node session cookie for the target node only', () => {
    const req = new Request(EXEC_URL, {
      headers: { cookie: `vibeterm_s_${OTHER}=sid-1; vibeterm_s_other=sid-2` },
    });
    expect(execForwardCredential(req, OTHER)).toBe('sid-1');
    expect(execForwardCredential(req, 'cc'.repeat(16))).toBeNull();
    expect(execForwardCredential(new Request(EXEC_URL), OTHER)).toBeNull();
  });
});

describe('forwarder /api/exec/ws', () => {
  test('upgrade without a target credential -> 401 NODE_LOGIN_REQUIRED', async () => {
    const mesh = await bootMesh();
    try {
      const { captured, server } = captureServer();
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(EXEC_URL, { headers: upgradeHeaders() }),
          server
        )
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'NODE_LOGIN_REQUIRED', nodeId: OTHER });
      expect(captured.calls).toBe(0);
    } finally {
      mesh.close();
    }
  });

  test('plain HTTP request -> 400 upgrade_required', async () => {
    const mesh = await bootMesh();
    try {
      const { captured, server } = captureServer();
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(EXEC_URL, { headers: { cookie: `vibeterm_s_${OTHER}=sid-1` } }),
          server
        )
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: 'upgrade_required' });
      expect(captured.calls).toBe(0);
    } finally {
      mesh.close();
    }
  });

  test('upgrade with a credential carries exec-forward data', async () => {
    const mesh = await bootMesh();
    try {
      const { captured, server } = captureServer();
      const res = await mesh.runtime.handleRequest(
        new Request(EXEC_URL, {
          headers: upgradeHeaders({ cookie: `vibeterm_s_${OTHER}=sid-1` }),
        }),
        server
      );
      expect(res).toBeUndefined();
      expect(captured.data?.kind).toBe(MESH_EXEC_FORWARD_KIND);
      expect(captured.data?.nodeId).toBe(OTHER);
      expect(captured.data?.credential).toBe('sid-1');
      expect(isExecForwardSocket({ data: captured.data })).toBe(true);
    } finally {
      mesh.close();
    }
  });

  test('open payload is {type:exec, credential} with no auth key, then bytes flow', async () => {
    const peers = new FakePeers();
    const stream = new FakeLinkStream();
    const payloads: Uint8Array[] = [];
    peers.links.set(OTHER, {
      openStream: async (payload: Uint8Array) => {
        payloads.push(payload);
        return stream;
      },
    } as unknown as LinkSession);
    const mesh = await bootMesh({ peers, streams: new FakeStreams() });
    try {
      const { captured, server } = captureServer();
      await mesh.runtime.handleRequest(
        new Request(EXEC_URL, {
          headers: upgradeHeaders({ cookie: `vibeterm_s_${OTHER}=sid-1` }),
        }),
        server
      );
      const data = captured.data as ExecForwardSocketData;
      const ws = new FakeWs(data);
      execForwardWebsocket.open(ws);
      await waitUntil(() => payloads.length === 1);
      expect(decodeJsonBytes(payloads[0] as Uint8Array)).toEqual({
        type: 'exec',
        credential: 'sid-1',
      });
      execForwardWebsocket.message(ws, new Uint8Array([1, 2, 3]));
      await waitUntil(() => stream.written.length === 1);
      expect([...(stream.written[0] as Uint8Array)]).toEqual([1, 2, 3]);
      stream.push(new Uint8Array([9]));
      await waitUntil(() => ws.sent.length === 1);
      execForwardWebsocket.close(ws);
      expect(stream.resetReason).toBe('client-closed');
    } finally {
      mesh.close();
    }
  });

  test('an unreachable node closes the websocket with 4502', async () => {
    const mesh = await bootMesh({ peers: new FakePeers() });
    try {
      const { captured, server } = captureServer();
      await mesh.runtime.handleRequest(
        new Request(EXEC_URL, {
          headers: upgradeHeaders({ cookie: `vibeterm_s_${OTHER}=sid-1` }),
        }),
        server
      );
      const ws = new FakeWs(captured.data as ExecForwardSocketData);
      execForwardWebsocket.open(ws);
      await waitUntil(() => ws.closed !== null);
      expect(ws.closed).toEqual({ code: 4502, reason: 'NODE_UNREACHABLE' });
    } finally {
      mesh.close();
    }
  });
});
