import {
  type PeerHello,
  buildPeerTranscript,
  decodeBase64url,
  decodeCertificate,
  derivePeerSessionKeys,
  encodeBase64url,
  encodePeerTranscript,
  generateX25519KeyPair,
  hexToBytes,
  nodeIdToHex,
  signTranscript,
  verifyTranscript,
} from '@tmex/shared/auth';
import {
  type ByteTransport,
  LinkMux,
  type LinkSession,
  type LinkStream,
  SecureChannelLink,
  type ServerSocketAdapter,
  WebSocketLink,
  type WebSocketTransportInput,
  byteTransportFromStream,
  secureChannelDirections,
  websocketTransport,
  x25519SharedSecret,
} from '@tmex/shared/link';
import type { UserStore } from '../auth/user-store';
import { decodeJsonBytes, encodeCtlMessage, isRecord, requireString } from './ctl';
import { type MeshIdentity, PeerHandshakeError, type PeerTransportKind } from './types';

export type PeerHelloWire = {
  t: 'hello';
  node_id: string;
  nonce: string;
  eph_x25519_pk: string;
  dtls_fingerprint?: { algorithm: string; value: string } | null;
};

export type PeerSigWire = {
  t: 'sig';
  sig: string;
};

export type PeerCtlPing = { t: 'ping' };
export type PeerCtlPong = { t: 'pong' };

export type PeerNodeStatusMsg = {
  t: 'node.status';
  version: string;
  tmux: boolean;
  direct_capable: boolean;
  inventory: unknown;
  endpoints: unknown;
  name?: string;
  key_log_head?: { seq: number | string; hash: string };
};

export type PeerKeyLogReq = { t: 'key.log.req'; from_seq: number | string };
export type PeerKeyLogRes = {
  t: 'key.log.res';
  records: { seq: number | string; bytes: string; sig: string }[];
};
export type PeerRtcSignal = {
  t: 'rtc.signal';
  rtcSession: string;
  from: 'browser' | 'node';
  to: string;
  sdp?: string;
  candidate?: string;
};

export type PeerCtlMessage =
  | PeerHelloWire
  | PeerSigWire
  | PeerCtlPing
  | PeerCtlPong
  | PeerNodeStatusMsg
  | PeerKeyLogReq
  | PeerKeyLogRes
  | PeerRtcSignal;

export type PeerHandshakeResult = {
  session: LinkSession;
  peerNodeId: string;
  transport: PeerTransportKind;
  sendKey?: Uint8Array;
  recvKey?: Uint8Array;
};

const HANDSHAKE_TIMEOUT_MS = 10_000;
const textDecoder = new TextDecoder();

export function encodePeerCtl(msg: PeerCtlMessage): Uint8Array {
  return encodeCtlMessage(msg);
}

export function decodePeerCtl(bytes: Uint8Array): Record<string, unknown> {
  const parsed = decodeJsonBytes(bytes);
  if (!isRecord(parsed) || typeof parsed.t !== 'string') {
    throw new PeerHandshakeError('protocol', 'peer ctl must be JSON with t');
  }
  return parsed;
}

function parseHello(msg: Record<string, unknown>): { hello: PeerHello; nodeIdHex: string } {
  if (msg.t !== 'hello') {
    throw new PeerHandshakeError('protocol', `expected hello, got ${String(msg.t)}`);
  }
  const nodeIdHex = requireString(msg.node_id, 'node_id').toLowerCase();
  const nonce = decodeBase64url(requireString(msg.nonce, 'nonce'));
  const eph = decodeBase64url(requireString(msg.eph_x25519_pk, 'eph_x25519_pk'));
  if (nonce.byteLength !== 32) {
    throw new PeerHandshakeError('protocol', 'hello nonce must be 32 bytes');
  }
  if (eph.byteLength !== 32) {
    throw new PeerHandshakeError('protocol', 'hello eph_x25519_pk must be 32 bytes');
  }
  const nodeId = hexToBytes(nodeIdHex);
  if (nodeId.byteLength !== 16) {
    throw new PeerHandshakeError('protocol', 'hello node_id must be 16 bytes');
  }
  let dtls: PeerHello['dtls_fingerprint'] = null;
  if (msg.dtls_fingerprint && isRecord(msg.dtls_fingerprint)) {
    dtls = {
      algorithm: requireString(msg.dtls_fingerprint.algorithm, 'dtls_fingerprint.algorithm'),
      value: requireString(msg.dtls_fingerprint.value, 'dtls_fingerprint.value'),
    };
  }
  return {
    nodeIdHex,
    hello: {
      node_id: nodeId,
      nonce,
      eph_x25519_pk: eph,
      dtls_fingerprint: dtls,
    },
  };
}

function lookupPeerEdPk(userStore: UserStore, nodeIdHex: string): Uint8Array {
  const cert = userStore.getCert(nodeIdHex);
  if (!cert) {
    throw new PeerHandshakeError('unknown', `no node_certs for ${nodeIdHex}`);
  }
  if (cert.revokedLogSeq != null) {
    throw new PeerHandshakeError('revoked', `node ${nodeIdHex} is revoked`);
  }
  const decoded = decodeCertificate(cert.certificateBytes);
  if (nodeIdToHex(decoded.node_id) !== nodeIdHex) {
    throw new PeerHandshakeError('protocol', 'certificate node_id mismatch');
  }
  return decoded.ed_pk;
}

type CtlIo = {
  send: (bytes: Uint8Array) => void | Promise<void>;
  recv: () => Promise<Uint8Array>;
};

function waitWithTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PeerHandshakeError('timeout', message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function ctlPushRecv(
  onMessage: (cb: (bytes: Uint8Array) => void) => void
): () => Promise<Uint8Array> {
  const pending: Uint8Array[] = [];
  const waiters: Array<(bytes: Uint8Array) => void> = [];
  onMessage((bytes) => {
    const waiter = waiters.shift();
    if (waiter) waiter(bytes);
    else pending.push(bytes);
  });
  return () => {
    if (pending.length > 0) {
      return Promise.resolve(pending.shift() as Uint8Array);
    }
    return new Promise((resolve) => waiters.push(resolve));
  };
}

async function exchangeHelloAndSig(
  io: CtlIo,
  opts: {
    identity: MeshIdentity;
    userStore: UserStore;
    path: 'dc' | 'relay';
    timeoutMs: number;
  }
): Promise<{
  peerNodeId: string;
  peerHello: PeerHello;
  selfHello: PeerHello;
  transcriptBytes: Uint8Array;
  ephSk: Uint8Array;
}> {
  const selfId = hexToBytes(opts.identity.nodeId);
  if (selfId.byteLength !== 16) {
    throw new PeerHandshakeError('protocol', 'identity.nodeId must be 16 bytes hex');
  }
  const eph = generateX25519KeyPair();
  const selfHello: PeerHello = {
    node_id: selfId,
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    eph_x25519_pk: eph.publicKey,
    dtls_fingerprint: null,
  };

  await io.send(
    encodePeerCtl({
      t: 'hello',
      node_id: nodeIdToHex(selfHello.node_id),
      nonce: encodeBase64url(selfHello.nonce),
      eph_x25519_pk: encodeBase64url(selfHello.eph_x25519_pk as Uint8Array),
      dtls_fingerprint: null,
    })
  );

  let peerHello: PeerHello | null = null;
  let peerNodeId = '';
  let gotSig: Uint8Array | null = null;
  let sentSig = false;

  const sendSigIfReady = async () => {
    if (sentSig || !peerHello) return;
    const transcript = buildPeerTranscript(opts.path, selfHello, peerHello);
    const sig = signTranscript(opts.identity.edSecretKey, transcript);
    sentSig = true;
    await io.send(encodePeerCtl({ t: 'sig', sig: encodeBase64url(sig) }));
  };

  await waitWithTimeout(
    (async () => {
      while (!peerHello || !gotSig) {
        const bytes = await io.recv();
        const msg = decodePeerCtl(bytes);
        if (msg.t === 'hello') {
          const parsed = parseHello(msg);
          peerHello = parsed.hello;
          peerNodeId = parsed.nodeIdHex;
          await sendSigIfReady();
        } else if (msg.t === 'sig') {
          gotSig = decodeBase64url(requireString(msg.sig, 'sig'));
        }
      }
    })(),
    opts.timeoutMs,
    'peer handshake timed out'
  );

  if (!peerHello || !gotSig) {
    throw new PeerHandshakeError('protocol', 'incomplete handshake');
  }
  await sendSigIfReady();

  const edPk = lookupPeerEdPk(opts.userStore, peerNodeId);
  const transcript = buildPeerTranscript(opts.path, selfHello, peerHello);
  const transcriptBytes = encodePeerTranscript(transcript);
  if (!verifyTranscript(transcriptBytes, gotSig, edPk)) {
    throw new PeerHandshakeError('bad_signature', 'peer transcript signature failed');
  }
  return {
    peerNodeId,
    peerHello,
    selfHello,
    transcriptBytes,
    ephSk: eph.secretKey,
  };
}

/**
 * Interim LAN path uses transcript `path: 'relay'` (same HKDF binding as hub
 * relay). `'dc'` is reserved for Phase 3 DataChannel + DTLS fingerprints.
 */
export const WS_SECURE_TRANSCRIPT_PATH = 'relay' as const;

function createHandshakeGate(inner: ByteTransport): {
  send: (bytes: Uint8Array) => void | Promise<void>;
  recv: () => Promise<Uint8Array>;
  finish: () => ByteTransport;
  fail: (reason: string) => void;
} {
  type Waiter = { resolve: (bytes: Uint8Array) => void; reject: (err: Error) => void };
  let phase: 'hs' | 'up' = 'hs';
  const pending: Uint8Array[] = [];
  const waiters: Waiter[] = [];
  const dataCbs: Array<(bytes: Uint8Array) => void> = [];
  const closeCbs: Array<(reason?: string) => void> = [];
  let closedReason: string | null = null;

  inner.onData((bytes) => {
    if (phase === 'hs') {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(bytes);
      else pending.push(bytes);
      return;
    }
    for (const cb of dataCbs) cb(bytes);
  });
  inner.onClose((reason) => {
    closedReason = reason ?? 'closed';
    if (phase === 'hs') {
      const err = new PeerHandshakeError('protocol', closedReason);
      for (const waiter of waiters.splice(0)) waiter.reject(err);
    }
    for (const cb of closeCbs) cb(reason);
  });

  return {
    send: (bytes) => inner.send(bytes),
    recv: () => {
      if (closedReason) {
        return Promise.reject(new PeerHandshakeError('protocol', closedReason));
      }
      if (pending.length > 0) {
        return Promise.resolve(pending.shift() as Uint8Array);
      }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    finish: () => {
      phase = 'up';
      return {
        send: (bytes) => inner.send(bytes),
        onData(cb) {
          dataCbs.push(cb);
          while (pending.length > 0) cb(pending.shift() as Uint8Array);
        },
        onClose(cb) {
          closeCbs.push(cb);
          if (closedReason) cb(closedReason);
        },
        close(reason) {
          inner.close(reason);
        },
      };
    },
    fail: (reason) => {
      try {
        inner.close(reason);
      } catch {
        // already closed
      }
    },
  };
}

export async function handshakeWsDirect(opts: {
  socket: WebSocketTransportInput;
  role: 'initiator' | 'acceptor';
  identity: MeshIdentity;
  userStore: UserStore;
  timeoutMs?: number;
}): Promise<PeerHandshakeResult> {
  const inner = websocketTransport(opts.socket);
  const gate = createHandshakeGate(inner);
  try {
    const result = await exchangeHelloAndSig(
      {
        send: (bytes) => gate.send(bytes),
        recv: () => gate.recv(),
      },
      {
        identity: opts.identity,
        userStore: opts.userStore,
        path: WS_SECURE_TRANSCRIPT_PATH,
        timeoutMs: opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      }
    );
    const peerEph = result.peerHello.eph_x25519_pk;
    if (!peerEph) {
      throw new PeerHandshakeError('protocol', 'ws-secure hello missing eph_x25519_pk');
    }
    const shared = x25519SharedSecret(result.ephSk, peerEph);
    const selfId = hexToBytes(opts.identity.nodeId);
    const peerId = hexToBytes(result.peerNodeId);
    const keys = derivePeerSessionKeys(shared, result.transcriptBytes, selfId, peerId);
    const directions = secureChannelDirections(opts.role);
    const secure = new SecureChannelLink(gate.finish(), {
      sendKey: keys.sendKey,
      recvKey: keys.recvKey,
      ...directions,
    });
    const session = new LinkMux(secure, { role: opts.role });
    return {
      session,
      peerNodeId: result.peerNodeId,
      transport: 'ws-secure',
      sendKey: keys.sendKey,
      recvKey: keys.recvKey,
    };
  } catch (err) {
    gate.fail(err instanceof Error ? err.message : 'handshake-failed');
    throw err;
  }
}

export async function handshakeRelay(opts: {
  stream: LinkStream;
  role: 'initiator' | 'acceptor';
  identity: MeshIdentity;
  userStore: UserStore;
  timeoutMs?: number;
}): Promise<PeerHandshakeResult> {
  const reader = opts.stream.readable.getReader();
  try {
    const result = await exchangeHelloAndSig(
      {
        send: (bytes) => opts.stream.write(bytes),
        recv: async () => {
          const { done, value } = await reader.read();
          if (done || !value) {
            throw new PeerHandshakeError('protocol', 'relay stream closed during handshake');
          }
          return value.bytes;
        },
      },
      {
        identity: opts.identity,
        userStore: opts.userStore,
        path: 'relay',
        timeoutMs: opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      }
    );
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
    const peerEph = result.peerHello.eph_x25519_pk;
    if (!peerEph) {
      throw new PeerHandshakeError('protocol', 'relay hello missing eph_x25519_pk');
    }
    const shared = x25519SharedSecret(result.ephSk, peerEph);
    const selfId = hexToBytes(opts.identity.nodeId);
    const peerId = hexToBytes(result.peerNodeId);
    const keys = derivePeerSessionKeys(shared, result.transcriptBytes, selfId, peerId);
    const directions = secureChannelDirections(opts.role);
    const secure = new SecureChannelLink(byteTransportFromStream(opts.stream), {
      sendKey: keys.sendKey,
      recvKey: keys.recvKey,
      ...directions,
    });
    const session = new LinkMux(secure, { role: opts.role });
    return {
      session,
      peerNodeId: result.peerNodeId,
      transport: 'relay',
      sendKey: keys.sendKey,
      recvKey: keys.recvKey,
    };
  } catch (err) {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
    try {
      opts.stream.reset(err instanceof Error ? err.message : 'handshake-failed');
    } catch {
      // already closed
    }
    throw err;
  }
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export function wrapBunPeerSocket(ws: {
  send: (data: Uint8Array | ArrayBuffer | Buffer) => number | undefined;
  close: (code?: number, reason?: string) => void;
}): ServerSocketAdapter & {
  ingestMessage: (data: unknown) => void;
  ingestClose: (reason?: string) => void;
  ingestDrain: () => void;
} {
  const messageCbs: Array<(bytes: Uint8Array) => void> = [];
  const closeCbs: Array<(reason?: string) => void> = [];
  const drainCbs: Array<() => void> = [];
  return {
    send(bytes) {
      return ws.send(bytes) ?? 0;
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    onMessage(cb) {
      messageCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    onDrain(cb) {
      drainCbs.push(cb);
    },
    ingestMessage(data) {
      const bytes = toUint8Array(data);
      if (!bytes) return;
      for (const cb of messageCbs) cb(bytes);
    },
    ingestClose(reason) {
      for (const cb of closeCbs) cb(reason);
    },
    ingestDrain() {
      for (const cb of drainCbs) cb();
    },
  };
}

export function openWebSocketLink(
  socket: WebSocketTransportInput,
  role: 'initiator' | 'acceptor'
): LinkSession {
  return new WebSocketLink(socket, { role });
}

export function parseOpenPayload(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const text = textDecoder.decode(bytes);
    if (!text) return {};
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
