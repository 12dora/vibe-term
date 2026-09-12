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
} from '@vibeterm/shared/auth';
import type { UserStore } from '../../auth/user-store';
import { decodeJsonBytes, isRecord, requireString } from '../ctl';
import { withPeerHandshakeTimeout } from '../peer-handshake-timeout';
import type { MeshIdentity } from '../types';
import { PeerHandshakeError } from '../types';
import { FANOUT_MAX_PENDING_BYTES, type FanoutDataChannel } from './channel-fanout';
import type { DataChannelLike, PeerConnectionLike } from './native';
import { toUint8Array } from './native';
import { rtcLog } from './rtc-log';

export const DC_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DC_HANDSHAKE_MAX_MESSAGE_BYTES = 4 * 1024;
export const DC_HANDSHAKE_MAX_QUEUE = 64;
export const DC_HANDSHAKE_HELLO_INTERVAL_MS = 500;
export const DC_HANDSHAKE_JSON_PROBE_BYTES = 16 * 1024;

export type DcHandshakeType = 'hello' | 'sig' | 'done' | 'ctl';

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

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function handshakeTypeFromParsed(parsed: unknown): DcHandshakeType {
  if (isRecord(parsed) && (parsed.t === 'hello' || parsed.t === 'sig' || parsed.t === 'done')) {
    return parsed.t;
  }
  return 'ctl';
}

export function dcHandshakeType(
  msg: string | Buffer | ArrayBuffer | ArrayBufferView
): DcHandshakeType | null {
  if (typeof msg === 'string') {
    const parsed = tryParseJson(msg);
    if (parsed === null) return 'ctl';
    return handshakeTypeFromParsed(parsed);
  }
  const bytes = toUint8Array(msg);
  if (bytes.byteLength === 0 || bytes[0] !== 0x7b) return null;
  if (bytes.byteLength > DC_HANDSHAKE_JSON_PROBE_BYTES) return null;
  try {
    return handshakeTypeFromParsed(decodeJsonBytes(bytes));
  } catch {
    return null;
  }
}

export function isDcHandshakeWire(msg: string | Buffer | ArrayBuffer | ArrayBufferView): boolean {
  return dcHandshakeType(msg) !== null;
}

function messageByteLength(msg: string | Buffer | ArrayBuffer): number {
  if (typeof msg === 'string') return Buffer.byteLength(msg);
  return msg.byteLength;
}

export type HandshakeRecv = {
  recv: () => Promise<Uint8Array>;
  stop: () => Array<string | Buffer | ArrayBuffer>;
};

function isHandshakeSlot(kind: DcHandshakeType | null): kind is 'hello' | 'sig' | 'done' {
  return kind === 'hello' || kind === 'sig' || kind === 'done';
}

function enqueueHandshakeSlot(
  pending: Uint8Array[],
  bytes: Uint8Array,
  kind: 'hello' | 'sig' | 'done',
  maxQueue: number,
  abort: (message: string) => void
): void {
  const prev = pending.findIndex((row) => dcHandshakeType(row) === kind);
  if (prev >= 0) pending.splice(prev, 1);
  if (pending.length >= maxQueue) {
    abort('dc handshake receive queue overflow');
    return;
  }
  pending.push(bytes);
}

export function attachHandshakeRecv(
  channel: DataChannelLike,
  pc: PeerConnectionLike,
  opts?: { peer?: string }
): HandshakeRecv {
  return recvQueue(channel, pc, {
    maxMessageBytes: DC_HANDSHAKE_MAX_MESSAGE_BYTES,
    maxQueue: DC_HANDSHAKE_MAX_QUEUE,
    peer: opts?.peer,
  });
}

function recvQueue(
  channel: DataChannelLike,
  pc: PeerConnectionLike,
  limits: { maxMessageBytes: number; maxQueue: number; peer?: string }
): HandshakeRecv {
  const pendingHandshake: Uint8Array[] = [];
  const pendingPayload: Array<string | Buffer | ArrayBuffer> = [];
  let pendingPayloadBytes = 0;
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
    pendingHandshake.length = 0;
    pendingPayload.length = 0;
    pendingPayloadBytes = 0;
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

  const deliverHandshake = (bytes: Uint8Array) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(bytes);
      return;
    }
    const kind = dcHandshakeType(bytes);
    if (!isHandshakeSlot(kind)) return;
    enqueueHandshakeSlot(pendingHandshake, bytes, kind, limits.maxQueue, abort);
  };

  const enqueuePayload = (msg: string | Buffer | ArrayBuffer) => {
    const size = messageByteLength(msg);
    if (pendingPayloadBytes + size > FANOUT_MAX_PENDING_BYTES) {
      rtcLog('buffer overflow', {
        peer: limits.peer ?? 'unknown',
        dropped: pendingPayload.length + 1,
      });
      abort('dc handshake buffer overflow');
      return;
    }
    pendingPayload.push(msg);
    pendingPayloadBytes += size;
  };

  const unsubMessage: unknown = channel.onMessage((msg) => {
    if (stopped) return;
    const kind = dcHandshakeType(msg);
    if (isHandshakeSlot(kind)) {
      const bytes = toUint8Array(msg).slice();
      if (bytes.byteLength > limits.maxMessageBytes) {
        abort('dc handshake message too large');
        return;
      }
      deliverHandshake(bytes);
      return;
    }
    if (kind === 'ctl') return;
    enqueuePayload(msg);
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
      if (pendingHandshake.length > 0) {
        return Promise.resolve(pendingHandshake.shift() as Uint8Array);
      }
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
      pendingHandshake.length = 0;
      pendingPayloadBytes = 0;
      return pendingPayload.splice(0);
    },
  };
}

function reinjectPayloads(
  channel: DataChannelLike,
  leftovers: Array<string | Buffer | ArrayBuffer>
): void {
  if (leftovers.length === 0) return;
  const inject = (channel as FanoutDataChannel).reinjectMessages;
  if (typeof inject !== 'function') return;
  inject.call(channel, leftovers);
}

function sendHandshake(
  channel: DataChannelLike,
  msg: { t: string } & Record<string, unknown>
): void {
  channel.sendMessage(JSON.stringify(msg));
}

function buildSelfHello(identity: MeshIdentity, localFp: DtlsFingerprint): PeerHello {
  const selfId = hexToBytes(identity.nodeId);
  if (selfId.byteLength !== 16) {
    throw new PeerHandshakeError('protocol', 'identity.nodeId must be 16 bytes hex');
  }
  return {
    node_id: selfId,
    nonce: crypto.getRandomValues(new Uint8Array(32)),
    eph_x25519_pk: null,
    dtls_fingerprint: localFp,
  };
}

function startHelloRetransmit(
  channel: DataChannelLike,
  helloMsg: { t: string } & Record<string, unknown>
): () => void {
  let helloTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (!channel.isOpen()) return;
    sendHandshake(channel, helloMsg);
  }, DC_HANDSHAKE_HELLO_INTERVAL_MS);
  return () => {
    if (helloTimer === null) return;
    clearInterval(helloTimer);
    helloTimer = null;
  };
}

type HandshakeProgress = {
  peerHello: PeerHello | null;
  peerFingerprint: DtlsFingerprint | null;
  peerNodeId: string;
  gotSig: Uint8Array | null;
  sentSig: boolean;
  gotDone: boolean;
  verified: boolean;
};

async function exchangeHandshake(opts: {
  queue: HandshakeRecv;
  channel: DataChannelLike;
  pc: PeerConnectionLike;
  identity: MeshIdentity;
  userStore: UserStore;
  selfHello: PeerHello;
  stopHello: () => void;
}): Promise<HandshakeProgress> {
  const progress: HandshakeProgress = {
    peerHello: null,
    peerFingerprint: null,
    peerNodeId: '',
    gotSig: null,
    sentSig: false,
    gotDone: false,
    verified: false,
  };
  const send = (msg: { t: string } & Record<string, unknown>) => sendHandshake(opts.channel, msg);
  const sendSigIfReady = () => {
    if (progress.sentSig || !progress.peerHello) return;
    const transcript = buildPeerTranscript('dc', opts.selfHello, progress.peerHello);
    progress.sentSig = true;
    send({ t: 'sig', sig: encodeBase64url(signTranscript(opts.identity.edSecretKey, transcript)) });
  };
  const verifyAndAck = () => {
    if (progress.verified || !progress.peerHello || !progress.gotSig) return;
    const edPk = lookupPeerEdPk(opts.userStore, progress.peerNodeId);
    const transcript = buildPeerTranscript('dc', opts.selfHello, progress.peerHello);
    if (!verifyTranscript(encodePeerTranscript(transcript), progress.gotSig, edPk)) {
      throw new PeerHandshakeError('bad_signature', 'peer transcript signature failed');
    }
    if (!progress.peerFingerprint) {
      throw new PeerHandshakeError('protocol', 'peer hello missing dtls_fingerprint');
    }
    if (!fingerprintsEqual(progress.peerFingerprint, opts.pc.remoteFingerprint())) {
      throw new PeerHandshakeError('protocol', 'dtls fingerprint mismatch');
    }
    progress.verified = true;
    send({ t: 'done' });
  };
  while (!progress.verified || !progress.gotDone) {
    if (progress.peerHello && progress.gotSig && !progress.verified) {
      sendSigIfReady();
      verifyAndAck();
      continue;
    }
    const bytes = await opts.queue.recv();
    let parsed: unknown;
    try {
      parsed = decodeJsonBytes(bytes);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.t !== 'string') continue;
    if (parsed.t === 'hello') {
      opts.stopHello();
      const hello = parseHello(parsed);
      progress.peerHello = hello.hello;
      progress.peerFingerprint = hello.fingerprint;
      progress.peerNodeId = hello.nodeIdHex;
      sendSigIfReady();
    } else if (parsed.t === 'sig') {
      opts.stopHello();
      progress.gotSig = decodeBase64url(requireString(parsed.sig, 'sig'));
    } else if (parsed.t === 'done') {
      progress.gotDone = true;
    }
  }
  return progress;
}

export async function handshakeDataChannel(opts: {
  channel: DataChannelLike;
  pc: PeerConnectionLike;
  identity: MeshIdentity;
  userStore: UserStore;
  localFingerprint: DtlsFingerprint;
  timeoutMs?: number;
  queue?: HandshakeRecv;
}): Promise<{ peerNodeId: string; peerHello: PeerHello }> {
  const timeoutMs = opts.timeoutMs ?? DC_HANDSHAKE_TIMEOUT_MS;
  const localFp = normalizeFingerprint(opts.localFingerprint);
  const selfHello = buildSelfHello(opts.identity, localFp);
  const queue =
    opts.queue ??
    attachHandshakeRecv(opts.channel, opts.pc, { peer: nodeIdToHex(selfHello.node_id) });
  const helloMsg = {
    t: 'hello',
    node_id: nodeIdToHex(selfHello.node_id),
    nonce: encodeBase64url(selfHello.nonce),
    dtls_fingerprint: localFp,
  };
  sendHandshake(opts.channel, helloMsg);
  const stopHello = startHelloRetransmit(opts.channel, helloMsg);
  let leftovers: Array<string | Buffer | ArrayBuffer> = [];
  let progress: HandshakeProgress | null = null;
  try {
    progress = await withPeerHandshakeTimeout(
      exchangeHandshake({
        queue,
        channel: opts.channel,
        pc: opts.pc,
        identity: opts.identity,
        userStore: opts.userStore,
        selfHello,
        stopHello,
      }),
      timeoutMs,
      'dc handshake timed out'
    );
  } finally {
    stopHello();
    leftovers = queue.stop();
  }
  if (!progress?.verified || !progress.gotDone || !progress.peerHello) {
    throw new PeerHandshakeError('protocol', 'incomplete dc handshake');
  }
  reinjectPayloads(opts.channel, leftovers);
  return { peerNodeId: progress.peerNodeId, peerHello: progress.peerHello };
}
