import {
  createNodeCertificate,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  nodeIdToHex,
  randomBytes,
} from '@tmex/shared/auth';
import type { ServerSocketAdapter } from '@tmex/shared/link';
import type { UserStore } from '../auth/user-store';
import type { MeshIdentity, MeshScheduler } from './types';

export class FakeServerSocket implements ServerSocketAdapter {
  peer: FakeServerSocket | null = null;
  closed = false;
  private readonly messageCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<(reason?: string) => void> = [];
  private readonly drainCbs: Array<() => void> = [];
  private readonly pending: Uint8Array[] = [];

  send(bytes: Uint8Array): number {
    if (this.closed || !this.peer) return 0;
    const copy = bytes.slice();
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer.closed) return;
      if (peer.messageCbs.length === 0) {
        peer.pending.push(copy);
        return;
      }
      for (const cb of peer.messageCbs) cb(copy);
    });
    return bytes.byteLength;
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

export function fakeSocketPair(): [FakeServerSocket, FakeServerSocket] {
  const a = new FakeServerSocket();
  const b = new FakeServerSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

export class ImmediateScheduler implements MeshScheduler {
  nowMs = 1_000;
  sleeps = 0;
  readonly intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];

  now(): number {
    return this.nowMs;
  }

  async sleep(_ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    this.sleeps += 1;
  }

  interval(fn: () => void, ms: number): { clear: () => void } {
    const handle = { fn, ms, cleared: false };
    this.intervals.push(handle);
    return {
      clear() {
        handle.cleared = true;
      },
    };
  }

  tickIntervals(): void {
    for (const handle of this.intervals) {
      if (!handle.cleared) handle.fn();
    }
  }
}

export function seedUser(store: UserStore, id = 'user-1'): void {
  store.create({
    id,
    username: `user-${id}`,
    rootPublicKey: randomBytes(32),
    rootEpoch: 0,
    kdfParamsJson: '{}',
    keyLogHeadSeq: 0,
    keyLogHeadHash: new Uint8Array(32),
    now: 1_000,
  });
}

export function seedNodeIdentity(
  store: UserStore,
  userId: string,
  opts?: { nodeId?: Uint8Array }
): MeshIdentity & { publicKey: Uint8Array; nodeIdBytes: Uint8Array } {
  const pair = generateEd25519KeyPair();
  const nodeId = opts?.nodeId ?? randomBytes(16);
  const x = generateX25519KeyPair();
  const enroll = generateEd25519KeyPair();
  const cert = createNodeCertificate(enroll.secretKey, {
    uid: userId,
    edPk: pair.publicKey,
    x25519Pk: x.publicKey,
    enrollPk: enroll.publicKey,
    now: Date.now(),
    nodeId,
  });
  store.upsertCert({
    nodeId: nodeIdToHex(cert.nodeId),
    userId,
    admitRecordSeq: 1,
    certificateBytes: cert.certificateBytes,
    certSig: cert.certSig,
    authorizationBytes: randomBytes(40),
    authorizationSig: randomBytes(64),
  });
  return {
    nodeId: nodeIdToHex(cert.nodeId),
    edSecretKey: pair.secretKey,
    publicKey: pair.publicKey,
    nodeIdBytes: cert.nodeId,
  };
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
  stepMs = 5
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
