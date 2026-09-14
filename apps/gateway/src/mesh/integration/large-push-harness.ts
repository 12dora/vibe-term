import {
  SERVER_WS_BACKPRESSURE_LIMIT,
  type ServerSocketAdapter,
  WebSocketLink,
} from '@vibeterm/shared/link';
import {
  type RelayMeshHarness,
  bootRelayMeshHarness,
} from '../../relay/integration/relay-mesh-harness';
import { Forwarder } from '../forwarder';
import type { MeshRuntime } from '../mesh-runtime';
import { openHttpStream } from '../stream-targets';
import type { DispatchHttp } from '../types';
import {
  type BootUser,
  jarFor,
  loginRemote,
  loginSelf,
  selfCookie,
  sidFromResponse,
} from './mesh-http-helpers';

export const LARGE_PUSH_BYTES = 24 * 1024 * 1024;
export const LARGE_PUSH_CHUNK = 64 * 1024;
export const COUNT_BYTES_PATH = '/api/test/count-bytes';

export type ByteCounter = {
  received: number;
  requests: number;
};

type PeerDispatchOwner = {
  dispatchHttp?: DispatchHttp;
};

export type LargePushPair = {
  a: { mesh: MeshRuntime };
  c: { mesh: MeshRuntime };
  boot: BootUser;
  counter: ByteCounter;
  stop: () => Promise<void>;
};

class BackpressuredServerSocket implements ServerSocketAdapter {
  peer: BackpressuredServerSocket | null = null;
  closed = false;
  buffered = 0;
  private readonly messageCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<(reason?: string) => void> = [];
  private readonly drainCbs: Array<() => void> = [];
  private readonly pending: Uint8Array[] = [];

  constructor(private readonly limit = SERVER_WS_BACKPRESSURE_LIMIT) {}

  send(bytes: Uint8Array): number {
    if (this.closed || !this.peer) return 0;
    if (this.buffered + bytes.byteLength > this.limit) {
      this.close(1001, 'backpressure-limit');
      return 0;
    }
    this.buffered += bytes.byteLength;
    const copy = bytes.slice();
    const peer = this.peer;
    const n = bytes.byteLength;
    queueMicrotask(() => {
      if (peer.closed) return;
      if (peer.messageCbs.length === 0) {
        peer.pending.push(copy);
      } else {
        for (const cb of peer.messageCbs) cb(copy);
      }
      this.buffered = Math.max(0, this.buffered - n);
      if (this.buffered === 0) {
        for (const cb of this.drainCbs) cb();
      }
    });
    return n;
  }

  close(_code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    this.peer = null;
    const why = reason || 'closed';
    if (peer && !peer.closed) {
      peer.closed = true;
      peer.peer = null;
      for (const cb of peer.closeCbs) cb(why);
    }
    for (const cb of this.closeCbs) cb(why);
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.messageCbs.push(cb);
    if (this.pending.length === 0) return;
    queueMicrotask(() => {
      const queued = this.pending.splice(0);
      for (const bytes of queued) {
        for (const listener of this.messageCbs) listener(bytes);
      }
    });
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCbs.push(cb);
  }

  onDrain(cb: () => void): void {
    this.drainCbs.push(cb);
  }
}

function backpressuredPair(): [BackpressuredServerSocket, BackpressuredServerSocket] {
  const a = new BackpressuredServerSocket();
  const b = new BackpressuredServerSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

export function installByteCountHandler(mesh: MeshRuntime, counter: ByteCounter): void {
  const peers = mesh.peers as unknown as PeerDispatchOwner;
  const orig = peers.dispatchHttp;
  peers.dispatchHttp = async (request, ctx) => {
    const url = new URL(request.url);
    if (request.method === 'PUT' && url.pathname === COUNT_BYTES_PATH) {
      counter.requests += 1;
      const reader = request.body?.getReader();
      if (!reader) {
        return new Response(JSON.stringify({ received: 0 }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value?.byteLength ?? 0;
      }
      counter.received = received;
      return new Response(JSON.stringify({ received }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (!orig) {
      return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 });
    }
    return orig(request, ctx);
  };
}

export function makeForwarder(mesh: MeshRuntime): Forwarder {
  return new Forwarder({
    nodeId: mesh.nodeId,
    peers: {
      getLink: (nodeId) => mesh.peers.getLink(nodeId),
      listReach: () => mesh.peers.listReach(),
      transportOf: (nodeId) => mesh.peers.transportOf(nodeId),
      onNodeEvent: (cb) => mesh.onNodeEvent(cb),
    },
    streams: {
      openHttpStream: (link, open, body, signal) =>
        openHttpStream(link, { type: 'http', ...open }, body, signal),
      openWsStream: async () => {
        throw new Error('ws not used');
      },
    },
  });
}

export function repeatingBody(
  total: number,
  fill = 0x5a,
  chunkSize = LARGE_PUSH_CHUNK
): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(chunkSize).fill(fill);
  let remaining = total;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const n = Math.min(chunk.byteLength, remaining);
      controller.enqueue(n === chunk.byteLength ? chunk : chunk.subarray(0, n));
      remaining -= n;
    },
  });
}

export async function bootEntryAndLeaf(): Promise<LargePushPair> {
  const harness: RelayMeshHarness = await bootRelayMeshHarness();
  const tenant = await harness.createTenant('alice');
  await tenant.enroll();
  const leaf = await tenant.joinNode('node-c');
  const counter: ByteCounter = { received: 0, requests: 0 };
  installByteCountHandler(leaf.mesh, counter);
  return {
    a: { mesh: tenant.owner.mesh },
    c: { mesh: leaf.mesh },
    boot: {
      userId: tenant.userId,
      rootKey: tenant.rootKey,
      rootPublicKey: tenant.rootPublicKey,
      rootEpoch: tenant.rootEpoch,
    },
    counter,
    stop: () => harness.stop(),
  };
}

export async function loginEntryToLeaf(pair: LargePushPair): Promise<string> {
  const sid = await loginSelf(pair.a.mesh, pair.boot);
  const remote = await loginRemote(pair.a.mesh, pair.c.mesh, pair.boot, selfCookie(sid));
  if (remote.status !== 200) {
    throw new Error(`remote login ${remote.status}: ${await remote.text()}`);
  }
  const leafSid = sidFromResponse(remote, pair.c.mesh.nodeId);
  return jarFor(sid, pair.c.mesh.nodeId, leafSid);
}

export function adoptWsSecure(pair: LargePushPair): void {
  const [leftSock, rightSock] = backpressuredPair();
  const left = new WebSocketLink(leftSock, { role: 'initiator' });
  const right = new WebSocketLink(rightSock, { role: 'acceptor' });
  const keptA = pair.a.mesh.peers.adoptLink(
    pair.c.mesh.nodeId,
    left,
    'ws-secure',
    pair.a.mesh.nodeId
  );
  const keptC = pair.c.mesh.peers.adoptLink(
    pair.a.mesh.nodeId,
    right,
    'ws-secure',
    pair.c.mesh.nodeId
  );
  if (!keptA || !keptC) throw new Error('adopt ws-secure failed');
}
