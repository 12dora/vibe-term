import {
  type DtlsFingerprint,
  type PeerHello,
  buildPeerTranscript,
  decodeBase64url,
  decodeCertificate,
  encodeBase64url,
  encodePeerTranscript,
  hexToBytes,
  nodeIdToHex,
  normalizeFingerprint,
  signTranscript,
  verifyTranscript,
} from '@tmex/shared/auth';
import type { UserStore } from '../../auth/user-store';
import { decodeJsonBytes, encodeCtlMessage, isRecord, requireString } from '../ctl';
import type { MeshIdentity } from '../types';
import { PeerHandshakeError } from '../types';
import type { FanoutDataChannel } from './channel-fanout';
import type { DataChannelLike, PeerConnectionLike } from './native';
import { sendBinary, toUint8Array } from './native';

export const DC_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DC_HANDSHAKE_MAX_MESSAGE_BYTES = 4 * 1024;
export const DC_HANDSHAKE_MAX_QUEUE = 8;

function fingerprintsEqual(a: DtlsFingerprint, b: DtlsFingerprint): boolean {
  const left = normalizeFingerprint(a);
  const right = normalizeFingerprint(b);
  return left.algorithm === right.algorithm && left.value === right.value;
}

function lookupPeerEdPk(userStore: UserStore, nodeIdHex: string): Uint8Array {
  const cert = userStore.getCert(nodeIdHex);
  if (!cert) {
    throw new PeerHandshakeError('unknown', `no node_certs for ${nodeIdHex}`);
  }
  if (cert.revokedLogSeq != null) {
    throw new PeerHandshakeError('revoked', `node ${nodeIdHex} is revoked`);
  }
  return decodeCertificate(cert.certificateBytes).ed_pk;
}

function parseHello(msg: Record<string, unknown>): {
  hello: PeerHello;
  nodeIdHex: string;
  fingerprint: DtlsFingerprint;
} {
  const nodeIdHex = requireString(msg.node_id, 'node_id').toLowerCase();
  const nonce = decodeBase64url(requireString(msg.nonce, 'nonce'));
  if (nonce.byteLength !== 32) {
    throw new PeerHandshakeError('protocol', 'hello nonce must be 32 bytes');
  }
  const nodeId = hexToBytes(nodeIdHex);
  if (nodeId.byteLength !== 16) {
    throw new PeerHandshakeError('protocol', 'hello node_id must be 16 bytes');
  }
  const fpRaw = msg.dtls_fingerprint;
  if (!isRecord(fpRaw)) {
    throw new PeerHandshakeError('protocol', 'dc hello missing dtls_fingerprint');
  }
  const dtls = normalizeFingerprint({
    algorithm: requireString(fpRaw.algorithm, 'dtls_fingerprint.algorithm'),
    value: requireString(fpRaw.value, 'dtls_fingerprint.value'),
  });
  return {
    nodeIdHex,
    fingerprint: dtls,
    hello: {
      node_id: nodeId,
      nonce,
      eph_x25519_pk: null,
      dtls_fingerprint: dtls,
    } as PeerHello,
  };
}

function recvQueue(
  channel: DataChannelLike,
  pc: PeerConnectionLike,
  limits: { maxMessageBytes: number; maxQueue: number }
): {
  recv: () => Promise<Uint8Array>;
  stop: () => Uint8Array[];
} {
  const pending: Uint8Array[] = [];
  const waiters: Array<{
    resolve: (bytes: Uint8Array) => void;
    reject: (err: Error) => void;
  }> = [];
  let stopped = false;
  let abortErr: PeerHandshakeError | null = null;

  const abort = (message: string) => {
    if (abortErr || stopped) return;
    abortErr = new PeerHandshakeError('protocol', message);
    stopped = true;
    pending.length = 0;
    const waiting = waiters.splice(0);
    for (const waiter of waiting) waiter.reject(abortErr);
    try {
      channel.close();
    } catch {
      // already closed
    }
    try {
      pc.close();
    } catch {
      // already closed
    }
  };

  const unsubMessage: unknown = channel.onMessage((msg) => {
    if (stopped) return;
    const bytes = toUint8Array(msg).slice();
    if (bytes.byteLength > limits.maxMessageBytes) {
      abort('dc handshake message too large');
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(bytes);
      return;
    }
    if (pending.length >= limits.maxQueue) {
      abort('dc handshake receive queue overflow');
      return;
    }
    pending.push(bytes);
  });
  const unsubClosed: unknown = channel.onClosed(() => {
    abort('dc handshake channel closed');
  });

  const detach = () => {
    if (typeof unsubMessage === 'function') (unsubMessage as () => void)();
    if (typeof unsubClosed === 'function') (unsubClosed as () => void)();
  };

  return {
    recv: () => {
      if (abortErr) return Promise.reject(abortErr);
      if (pending.length > 0) return Promise.resolve(pending.shift() as Uint8Array);
      return new Promise((resolve, reject) => {
        if (abortErr) {
          reject(abortErr);
          return;
        }
        waiters.push({ resolve, reject });
      });
    },
    stop: () => {
      stopped = true;
      detach();
      return pending.splice(0);
    },
  };
}

function isHandshakeCtl(bytes: Uint8Array): boolean {
  try {
    const parsed = decodeJsonBytes(bytes);
    return isRecord(parsed) && (parsed.t === 'hello' || parsed.t === 'sig');
  } catch {
    return false;
  }
}

function reinjectHandshakeLeftovers(channel: DataChannelLike, leftovers: Uint8Array[]): void {
  const replay = leftovers.filter((bytes) => !isHandshakeCtl(bytes));
  if (replay.length === 0) return;
  const inject = (channel as FanoutDataChannel).reinjectMessages;
  if (typeof inject !== 'function') return;
  inject.call(
    channel,
    replay.map((bytes) => Buffer.from(bytes))
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
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

export async function handshakeDataChannel(opts: {
  channel: DataChannelLike;
  pc: PeerConnectionLike;
  identity: MeshIdentity;
  userStore: UserStore;
  localFingerprint: DtlsFingerprint;
  timeoutMs?: number;
}): Promise<{ peerNodeId: string; peerHello: PeerHello }> {
  const timeoutMs = opts.timeoutMs ?? DC_HANDSHAKE_TIMEOUT_MS;
  const selfId = hexToBytes(opts.identity.nodeId);
  if (selfId.byteLength !== 16) {
    throw new PeerHandshakeError('protocol', 'identity.nodeId must be 16 bytes hex');
  }
  const localFp = normalizeFingerprint(opts.localFingerprint);
  const selfHello: PeerHello = {
    node_id: selfId,
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    eph_x25519_pk: null,
    dtls_fingerprint: localFp,
  };
  const queue = recvQueue(opts.channel, opts.pc, {
    maxMessageBytes: DC_HANDSHAKE_MAX_MESSAGE_BYTES,
    maxQueue: DC_HANDSHAKE_MAX_QUEUE,
  });
  const send = (msg: { t: string } & Record<string, unknown>) => {
    sendBinary(opts.channel, encodeCtlMessage(msg));
  };

  const helloMsg = {
    t: 'hello',
    node_id: nodeIdToHex(selfHello.node_id),
    nonce: encodeBase64url(selfHello.nonce),
    dtls_fingerprint: localFp,
  };
  send(helloMsg);
  const helloTimer = setInterval(() => {
    if (!opts.channel.isOpen()) return;
    send(helloMsg);
  }, 40);

  let peerHello: PeerHello | null = null;
  let peerFingerprint: DtlsFingerprint | null = null;
  let peerNodeId = '';
  let gotSig: Uint8Array | null = null;
  let sentSig = false;
  const leftovers: Uint8Array[] = [];

  const sendSigIfReady = () => {
    if (sentSig || !peerHello) return;
    const transcript = buildPeerTranscript('dc', selfHello, peerHello);
    const sig = signTranscript(opts.identity.edSecretKey, transcript);
    sentSig = true;
    send({ t: 'sig', sig: encodeBase64url(sig) });
  };

  try {
    await withTimeout(
      (async () => {
        while (!peerHello || !gotSig) {
          const bytes = await queue.recv();
          let parsed: unknown;
          try {
            parsed = decodeJsonBytes(bytes);
          } catch {
            leftovers.push(bytes);
            continue;
          }
          if (!isRecord(parsed) || typeof parsed.t !== 'string') {
            leftovers.push(bytes);
            continue;
          }
          if (parsed.t === 'hello') {
            const hello = parseHello(parsed);
            peerHello = hello.hello;
            peerFingerprint = hello.fingerprint;
            peerNodeId = hello.nodeIdHex;
            sendSigIfReady();
          } else if (parsed.t === 'sig') {
            gotSig = decodeBase64url(requireString(parsed.sig, 'sig'));
          } else {
            leftovers.push(bytes);
          }
        }
      })(),
      timeoutMs,
      'dc handshake timed out'
    );
  } finally {
    clearInterval(helloTimer);
    leftovers.push(...queue.stop());
  }

  const finishedHello = peerHello;
  const finishedSig = gotSig;
  if (!finishedHello || !finishedSig) {
    throw new PeerHandshakeError('protocol', 'incomplete dc handshake');
  }
  sendSigIfReady();

  const edPk = lookupPeerEdPk(opts.userStore, peerNodeId);
  const transcript = buildPeerTranscript('dc', selfHello, finishedHello);
  if (!verifyTranscript(encodePeerTranscript(transcript), finishedSig, edPk)) {
    throw new PeerHandshakeError('bad_signature', 'peer transcript signature failed');
  }

  const advertised = peerFingerprint;
  if (!advertised) {
    throw new PeerHandshakeError('protocol', 'peer hello missing dtls_fingerprint');
  }
  const remote = opts.pc.remoteFingerprint();
  if (!fingerprintsEqual(advertised, remote)) {
    throw new PeerHandshakeError('protocol', 'dtls fingerprint mismatch');
  }
  reinjectHandshakeLeftovers(opts.channel, leftovers);
  return { peerNodeId, peerHello: finishedHello };
}
