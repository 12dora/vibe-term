import { afterEach, describe, expect, test } from 'bun:test';
import { FRAME_HEADER_SIZE, LinkMux, MAX_FRAME_PAYLOAD } from '@tmex/shared/link';
import { createMigratedAuthDb } from '../../auth/test-db';
import { UserStore } from '../../auth/user-store';
import type { RtcSignalMessage } from '../mesh-deps';
import { DC_MAX_MESSAGE_BYTES } from '../rtc/fragmenter';
import type { RtcSignaling } from '../rtc/ice';
import { RtcPeerManager } from '../rtc/rtc-peer-manager';
import { createFakeNativeModule } from '../rtc/test-fakes';
import { openHttpStream } from '../stream-targets';
import { seedNodeIdentity, seedUser } from '../test-support';

const EIGHT_MIB = 8 * 1024 * 1024;
const SIXTEEN_KIB = 16 * 1024;
const TWO_MIB = 2 * 1024 * 1024;

function loopbackSignaling(): [RtcSignaling, RtcSignaling] {
  const aCbs: Array<(msg: RtcSignalMessage) => void> = [];
  const bCbs: Array<(msg: RtcSignalMessage) => void> = [];
  const aInbox: RtcSignalMessage[] = [];
  const bInbox: RtcSignalMessage[] = [];

  function deliver(
    cbs: Array<(msg: RtcSignalMessage) => void>,
    inbox: RtcSignalMessage[],
    msg: RtcSignalMessage
  ): void {
    if (cbs.length === 0) {
      inbox.push(msg);
      return;
    }
    for (const cb of cbs) cb(msg);
  }

  function subscribe(
    cbs: Array<(msg: RtcSignalMessage) => void>,
    inbox: RtcSignalMessage[],
    cb: (msg: RtcSignalMessage) => void
  ): () => void {
    cbs.push(cb);
    while (inbox.length > 0) {
      const next = inbox.shift();
      if (next) cb(next);
    }
    return () => {
      const idx = cbs.indexOf(cb);
      if (idx >= 0) cbs.splice(idx, 1);
    };
  }

  return [
    {
      send: (msg) => deliver(bCbs, bInbox, msg),
      onMessage: (cb) => subscribe(aCbs, aInbox, cb),
    },
    {
      send: (msg) => deliver(aCbs, aInbox, msg),
      onMessage: (cb) => subscribe(bCbs, bInbox, cb),
    },
  ];
}

function fillPattern(bytes: Uint8Array, start = 0): Uint8Array {
  for (let i = 0; i < bytes.byteLength; i++) bytes[i] = (start + i) & 0xff;
  return bytes;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Matches Bun `Response(Uint8Array)` chunking for an 8 MiB body: 16 KiB then 2 MiB slices. */
function bunLikeChunks(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  if (bytes.byteLength === 0) return chunks;
  const first = Math.min(SIXTEEN_KIB, bytes.byteLength);
  chunks.push(bytes.subarray(0, first));
  for (let offset = first; offset < bytes.byteLength; offset += TWO_MIB) {
    chunks.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + TWO_MIB)));
  }
  return chunks;
}

describe('HTTP-style bulk over PeerManager DataChannel', () => {
  const fixtures: Array<{ close: () => void }> = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop()?.close();
  });

  function setup() {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new UserStore(db);
    seedUser(store);
    const a = seedNodeIdentity(store, 'user-1');
    const b = seedNodeIdentity(store, 'user-1');
    const fake = createFakeNativeModule();
    const ice = () => ({ stun: [] as string[], turn: null });
    const left = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: ice,
      identity: a,
      userStore: store,
      handshakeTimeoutMs: 2_000,
      liveness: false,
    });
    const right = new RtcPeerManager({
      loadNative: async () => fake.module,
      iceConfigProvider: ice,
      identity: b,
      userStore: store,
      handshakeTimeoutMs: 2_000,
      liveness: false,
    });
    fixtures.push({ close: () => left.close() });
    fixtures.push({ close: () => right.close() });
    return { a, b, left, right };
  }

  test('8 MiB HTTP-style body arrives in order; mux window throttles instead of truncating', async () => {
    const { left, right, a, b } = setup();
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    expect(la.link.channel.maxMessageSize()).toBeGreaterThanOrEqual(DC_MAX_MESSAGE_BYTES);

    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const open = new TextEncoder().encode('{"type":"http"}');
    const out = await muxA.openStream(open);
    const inn = await incomingP;
    expect(inn.openPayload).toEqual(open);

    const reader = inn.readable.getReader();
    const head = new TextEncoder().encode(
      '{"status":200,"headers":{"content-type":"application/octet-stream"}}'
    );
    await out.write(head, { head: true });
    const headChunk = await reader.read();
    expect(headChunk.value?.head).toBe(true);
    expect(headChunk.value?.bytes).toEqual(head);

    const body = fillPattern(new Uint8Array(EIGHT_MIB));
    let writeDone = false;
    let writeErr: unknown = null;
    const writeP = (async () => {
      for (const chunk of bunLikeChunks(body)) {
        await out.write(chunk);
      }
      await out.end();
      writeDone = true;
    })().catch((err) => {
      writeErr = err;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writeDone).toBe(false);
    expect(writeErr).toBeNull();

    const got: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) got.push(value.bytes);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await writeP;
    expect(writeErr).toBeNull();
    expect(writeDone).toBe(true);
    const received = concatChunks(got);
    expect(received.byteLength).toBe(EIGHT_MIB);
    expect(received).toEqual(body);

    inn.end();
    la.pc.close();
    lb.pc.close();
  });

  test('8 MiB with a keeping-up consumer (full 1 MiB mux frames) is not truncated', async () => {
    const { left, right, a, b } = setup();
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const out = await muxA.openStream(new TextEncoder().encode('{"type":"http"}'));
    const inn = await incomingP;
    const reader = inn.readable.getReader();
    const head = new TextEncoder().encode('{"status":200}');
    await out.write(head, { head: true });
    expect((await reader.read()).value?.head).toBe(true);

    const body = fillPattern(new Uint8Array(EIGHT_MIB));
    const got: Uint8Array[] = [];
    const readP = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) got.push(value.bytes);
      }
    })();
    for (const chunk of bunLikeChunks(body)) {
      await out.write(chunk);
    }
    await out.end();
    await readP;
    const received = concatChunks(got);
    expect(received.byteLength).toBe(EIGHT_MIB);
    expect(received).toEqual(body);
    inn.end();
    la.pc.close();
    lb.pc.close();
  });

  test('openHttpStream errors the HTTP body when the DC dies mid-body (not a silent short 200)', async () => {
    const { left, right, a, b } = setup();
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const peerReady = Promise.withResolvers<import('@tmex/shared/link').LinkStream>();
    muxB.onStream(async (stream) => {
      const head = new TextEncoder().encode(
        `{"status":200,"headers":{"content-type":"application/octet-stream","content-length":"${EIGHT_MIB}"}}`
      );
      await stream.write(head, { head: true });
      await stream.write(fillPattern(new Uint8Array(64 * 1024)));
      peerReady.resolve(stream);
    });
    const res = await openHttpStream(muxA, {
      type: 'http',
      method: 'GET',
      path: '/api/files/raw',
      origin: 'http://entry',
      auth: null,
    });
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body).toBeDefined();
    if (!body) throw new Error('missing response body');
    const reader = body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect((first.value?.byteLength ?? 0) > 0).toBe(true);

    const peer = await peerReady.promise;
    const rest = (async () => {
      let received = first.value?.byteLength ?? 0;
      while (true) {
        const next = await reader.read();
        if (next.done) return { received, done: true as const };
        received += next.value?.byteLength ?? 0;
      }
    })();
    la.link.close('channel-closed');
    peer.reset('channel-closed');
    let outcome: { received: number; done: true } | { error: unknown };
    try {
      outcome = await rest;
    } catch (err) {
      outcome = { error: err };
    }
    expect('error' in outcome).toBe(true);
    if (!('error' in outcome)) {
      expect(outcome.received).toBeLessThan(EIGHT_MIB);
    }

    lb.pc.close();
  });

  test('a stalled/closed DC stream errors the readable instead of a silent EOF', async () => {
    const { left, right, a, b } = setup();
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const out = await muxA.openStream(new TextEncoder().encode('{"type":"http"}'));
    const inn = await incomingP;
    const reader = inn.readable.getReader();
    await out.write(new Uint8Array([1, 2, 3]), { head: true });
    expect((await reader.read()).value?.bytes).toEqual(new Uint8Array([1, 2, 3]));

    la.link.close('channel-closed');
    await expect(reader.read()).rejects.toBeDefined();
    const closed = await inn.closed;
    expect(closed.reason).not.toBe('end');

    lb.pc.close();
  });

  test('max mux DATA frame (1 MiB payload + header) reassembles over 64 KiB DC fragments', async () => {
    const { left, right, a, b } = setup();
    const [sigA, sigB] = loopbackSignaling();
    const [la, lb] = await Promise.all([
      left.connectToPeer(b.nodeId, sigA),
      right.connectToPeer(a.nodeId, sigB),
    ]);
    const muxA = new LinkMux(la.link, { role: la.role });
    const muxB = new LinkMux(lb.link, { role: lb.role });
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      muxB.onStream(resolve)
    );
    const out = await muxA.openStream(new Uint8Array([1]));
    const inn = await incomingP;
    const reader = inn.readable.getReader();
    const payload = fillPattern(new Uint8Array(MAX_FRAME_PAYLOAD));
    await out.write(payload);
    const chunk = await reader.read();
    expect(chunk.value?.bytes.byteLength).toBe(MAX_FRAME_PAYLOAD);
    expect(chunk.value?.bytes).toEqual(payload);
    expect(MAX_FRAME_PAYLOAD + FRAME_HEADER_SIZE).toBeGreaterThan(1024 * 1024);
    out.end();
    inn.end();
    la.pc.close();
    lb.pc.close();
  });
});
