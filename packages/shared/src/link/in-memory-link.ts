import { LinkMux } from './mux';
import type { ByteTransport, LinkSession } from './types';

class PipeEnd implements ByteTransport {
  peer: PipeEnd | null = null;
  private readonly dataCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<(reason?: string) => void> = [];
  private closed = false;

  send(bytes: Uint8Array): void {
    if (this.closed) return;
    const peer = this.peer;
    if (!peer || peer.closed) return;
    const copy = bytes.slice();
    for (const cb of peer.dataCbs) cb(copy);
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCbs.push(cb);
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCbs.push(cb);
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    this.peer = null;
    if (peer && !peer.closed) {
      peer.closed = true;
      peer.peer = null;
      for (const cb of peer.closeCbs) cb(reason);
    }
    for (const cb of this.closeCbs) cb(reason);
  }
}

/** Direct in-process byte pipe. Sends are synchronous; LinkMux reentrancy is queued. */
export function createBytePipe(): [ByteTransport, ByteTransport] {
  const a = new PipeEnd();
  const b = new PipeEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

export function createInMemoryLinkPair(): [LinkSession, LinkSession] {
  const [a, b] = createBytePipe();
  return [new LinkMux(a, { role: 'initiator' }), new LinkMux(b, { role: 'acceptor' })];
}
