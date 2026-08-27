import { describe, expect, it } from 'bun:test';
import { x25519 } from '@noble/curves/ed25519.js';
import { encodeFrame, encodeFrameHeader, peekFrameHeader } from './codec';
import { createBytePipe } from './in-memory-link';
import { LinkMux } from './mux';
import {
  SC_DIRECTION_ACCEPTOR,
  SC_DIRECTION_INITIATOR,
  SC_REKEY_COUNTER,
  SecureChannelLink,
  buildAesGcmNonce,
  deriveSecureChannelKeys,
  secureChannelDirections,
  x25519SharedSecret,
} from './secure-channel-link';
import { FrameOp } from './types';
import { type ByteTransport, FRAME_HEADER_SIZE, GCM_TAG_LENGTH, type LinkStream } from './types';

function recordingPipe(): {
  inner: [ByteTransport, ByteTransport];
  sentA: Uint8Array[];
} {
  const [rawA, rawB] = createBytePipe();
  const sentA: Uint8Array[] = [];
  const wrapA: ByteTransport = {
    send(bytes) {
      sentA.push(bytes.slice());
      return rawA.send(bytes);
    },
    onData(cb) {
      rawA.onData(cb);
    },
    onClose(cb) {
      rawA.onClose(cb);
    },
    close(reason) {
      rawA.close(reason);
    },
  };
  return { inner: [wrapA, rawB], sentA };
}

describe('SecureChannelLink', () => {
  const sharedSecret = new Uint8Array(32).fill(0x11);
  const transcriptHash = new Uint8Array(32).fill(0x22);
  const nodeA = new Uint8Array(16).fill(0x33);
  const nodeB = new Uint8Array(16).fill(0x44);

  it('deriveSecureChannelKeys matches the fixed test vector', () => {
    // Inputs (document for the auth module cross-check):
    //   sharedSecret    = 32 × 0x11
    //   transcriptHash  = 32 × 0x22
    //   senderNodeId    = 16 × 0x33   (raw node_id bytes)
    //   receiverNodeId  = 16 × 0x44
    //   k = HKDF-SHA-256(ss, salt=transcriptHash, info="tmex-sc/v1/" ‖ sender ‖ "->" ‖ receiver, 32)
    const keys = deriveSecureChannelKeys(sharedSecret, transcriptHash, nodeA, nodeB);
    expect(Buffer.from(keys.sendKey).toString('hex')).toBe(
      '9bedf74372ce35b96fed7c4be7e4ab00a7d46bfc68a7b6c6d8c4651d7bb9167c'
    );
    expect(Buffer.from(keys.recvKey).toString('hex')).toBe(
      '5c82f44020726a4698df0075a900cb4192772a5e91f3ba9b04fd4105a504a888'
    );
  });

  it('gives each direction a distinct key and swaps on the peer', () => {
    const a = deriveSecureChannelKeys(sharedSecret, transcriptHash, nodeA, nodeB);
    const b = deriveSecureChannelKeys(sharedSecret, transcriptHash, nodeB, nodeA);
    expect(a.sendKey).toEqual(b.recvKey);
    expect(a.recvKey).toEqual(b.sendKey);
    expect(a.sendKey).not.toEqual(a.recvKey);
  });

  it('round-trips plaintext mux frames', async () => {
    const keys = deriveSecureChannelKeys(sharedSecret, transcriptHash, nodeA, nodeB);
    const [t1, t2] = createBytePipe();
    const scA = new SecureChannelLink(t1, {
      ...keys,
      ...secureChannelDirections('initiator'),
    });
    const scB = new SecureChannelLink(t2, {
      sendKey: keys.recvKey,
      recvKey: keys.sendKey,
      ...secureChannelDirections('acceptor'),
    });
    const a = new LinkMux(scA, { role: 'initiator' });
    const b = new LinkMux(scB, { role: 'acceptor' });
    const incomingP = new Promise<LinkStream>((resolve) => b.onStream(resolve));
    const out = await a.openStream(new TextEncoder().encode('sc'));
    const incoming = await incomingP;
    await out.write(new TextEncoder().encode('cipher-hello'), { head: true });
    out.end();
    const reader = incoming.readable.getReader();
    const chunk = await reader.read();
    expect(chunk.value?.head).toBe(true);
    expect(chunk.value).toBeDefined();
    if (!chunk.value) throw new Error('expected DATA chunk');
    expect(new TextDecoder().decode(chunk.value.bytes)).toBe('cipher-hello');
    expect((await reader.read()).done).toBe(true);
    incoming.end();
    expect((await out.closed).reason).toBe('end');
    a.close();
  });

  it('uses a unique nonce per frame (counter increments; reuse fails)', async () => {
    const keys = deriveSecureChannelKeys(sharedSecret, transcriptHash, nodeA, nodeB);
    const { inner, sentA } = recordingPipe();
    const scA = new SecureChannelLink(inner[0], {
      ...keys,
      ...secureChannelDirections('initiator'),
    });
    const scB = new SecureChannelLink(inner[1], {
      sendKey: keys.recvKey,
      recvKey: keys.sendKey,
      ...secureChannelDirections('acceptor'),
    });
    const received: Uint8Array[] = [];
    scB.onData((bytes) => received.push(bytes.slice()));
    const frame1 = encodeFrame({
      streamId: 1,
      op: FrameOp.DATA,
      payload: new Uint8Array([1, 2, 3]),
    });
    const frame2 = encodeFrame({
      streamId: 1,
      op: FrameOp.DATA,
      payload: new Uint8Array([4, 5, 6]),
    });
    await scA.send(frame1);
    await scA.send(frame2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(2);
    expect(sentA).toHaveLength(2);
    expect(sentA[0]).not.toEqual(sentA[1]);

    const wire2 = sentA[1];
    expect(wire2).toBeDefined();
    if (!wire2) throw new Error('expected second wire frame');
    const header = peekFrameHeader(wire2);
    expect(header).toBeDefined();
    if (!header) throw new Error('expected wire header');
    const ct = wire2.slice(FRAME_HEADER_SIZE);
    expect(header.length).toBe(ct.byteLength);
    const wireHeader = wire2.slice(0, FRAME_HEADER_SIZE);
    const recvKey = await crypto.subtle.importKey(
      'raw',
      keys.sendKey as unknown as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const good = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buildAesGcmNonce(SC_DIRECTION_INITIATOR, 1n) as unknown as BufferSource,
        additionalData: wireHeader as unknown as BufferSource,
        tagLength: 128,
      },
      recvKey,
      ct as unknown as BufferSource
    );
    expect(new Uint8Array(good)).toEqual(new Uint8Array([4, 5, 6]));
    await expect(
      crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: buildAesGcmNonce(SC_DIRECTION_INITIATOR, 0n) as unknown as BufferSource,
          additionalData: wireHeader as unknown as BufferSource,
          tagLength: 128,
        },
        recvKey,
        ct as unknown as BufferSource
      )
    ).rejects.toBeDefined();
  });

  it('uses the sent wire header as GCM AAD (len = ciphertext+tag)', async () => {
    const keys = deriveSecureChannelKeys(sharedSecret, transcriptHash, nodeA, nodeB);
    const { inner, sentA } = recordingPipe();
    const scA = new SecureChannelLink(inner[0], {
      ...keys,
      ...secureChannelDirections('initiator'),
    });
    await scA.send(
      encodeFrame({ streamId: 5, op: FrameOp.DATA, payload: new Uint8Array([9, 8, 7]) })
    );
    const captured = sentA[0];
    expect(captured).toBeDefined();
    if (!captured) throw new Error('expected wire frame');
    const header = peekFrameHeader(captured);
    expect(header).toBeDefined();
    if (!header) throw new Error('expected wire header');
    const ct = captured.slice(FRAME_HEADER_SIZE);
    expect(header.length).toBe(ct.byteLength);
    expect(header.length).toBe(3 + GCM_TAG_LENGTH);
    const wireHeader = captured.slice(0, FRAME_HEADER_SIZE);
    const ptHeader = encodeFrameHeader(header.streamId, header.op, header.flags, 3);
    const recvKey = await crypto.subtle.importKey(
      'raw',
      keys.sendKey as unknown as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const good = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buildAesGcmNonce(SC_DIRECTION_INITIATOR, 0n) as unknown as BufferSource,
        additionalData: wireHeader as unknown as BufferSource,
        tagLength: 128,
      },
      recvKey,
      ct as unknown as BufferSource
    );
    expect(new Uint8Array(good)).toEqual(new Uint8Array([9, 8, 7]));
    await expect(
      crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: buildAesGcmNonce(SC_DIRECTION_INITIATOR, 0n) as unknown as BufferSource,
          additionalData: ptHeader as unknown as BufferSource,
          tagLength: 128,
        },
        recvKey,
        ct as unknown as BufferSource
      )
    ).rejects.toBeDefined();
  });

  it('fails closed when ciphertext is tampered', async () => {
    const keys = deriveSecureChannelKeys(sharedSecret, transcriptHash, nodeA, nodeB);
    const { inner, sentA } = recordingPipe();
    const scA = new SecureChannelLink(inner[0], {
      ...keys,
      ...secureChannelDirections('initiator'),
    });
    const [recvInner, inject] = createBytePipe();
    const scB = new SecureChannelLink(recvInner, {
      sendKey: keys.recvKey,
      recvKey: keys.sendKey,
      ...secureChannelDirections('acceptor'),
    });
    const closed = new Promise<string | undefined>((resolve) => scB.onClose(resolve));
    await scA.send(encodeFrame({ streamId: 1, op: FrameOp.DATA, payload: new Uint8Array([9]) }));
    const captured = sentA[0];
    expect(captured).toBeDefined();
    if (!captured) throw new Error('expected wire frame');
    const wire = captured.slice();
    wire[FRAME_HEADER_SIZE] ^= 0xff;
    inject.send(wire);
    expect(await closed).toBeDefined();
  });

  it('fails closed when the plaintext AAD header is tampered', async () => {
    const keys = deriveSecureChannelKeys(sharedSecret, transcriptHash, nodeA, nodeB);
    const { inner, sentA } = recordingPipe();
    const scA = new SecureChannelLink(inner[0], {
      ...keys,
      ...secureChannelDirections('initiator'),
    });
    const [recvInner, inject] = createBytePipe();
    const scB = new SecureChannelLink(recvInner, {
      sendKey: keys.recvKey,
      recvKey: keys.sendKey,
      ...secureChannelDirections('acceptor'),
    });
    const closed = new Promise<string | undefined>((resolve) => scB.onClose(resolve));
    await scA.send(encodeFrame({ streamId: 5, op: FrameOp.DATA, payload: new Uint8Array([9]) }));
    const captured = sentA[0];
    expect(captured).toBeDefined();
    if (!captured) throw new Error('expected wire frame');
    const wire = captured.slice();
    wire[0] ^= 0x01;
    inject.send(wire);
    expect(await closed).toBeDefined();
  });

  it('refuses further sends and emits rekeyNeeded near 2^63', async () => {
    const keys = deriveSecureChannelKeys(sharedSecret, transcriptHash, nodeA, nodeB);
    const [t1] = createBytePipe();
    const sc = new SecureChannelLink(t1, {
      ...keys,
      sendDirection: SC_DIRECTION_INITIATOR,
      recvDirection: SC_DIRECTION_ACCEPTOR,
      sendCounter: SC_REKEY_COUNTER,
    });
    let rekeyed = false;
    sc.onRekeyNeeded(() => {
      rekeyed = true;
    });
    await expect(
      sc.send(encodeFrame({ streamId: 1, op: FrameOp.DATA, payload: new Uint8Array([1]) }))
    ).rejects.toMatchObject({ code: 'rekey' });
    expect(rekeyed).toBe(true);
  });

  it('x25519SharedSecret agrees both ways', () => {
    const a = x25519.keygen();
    const b = x25519.keygen();
    expect(x25519SharedSecret(a.secretKey, b.publicKey)).toEqual(
      x25519SharedSecret(b.secretKey, a.publicKey)
    );
  });

  it('serializes concurrent sends so wire order matches counter order', async () => {
    const keys = deriveSecureChannelKeys(sharedSecret, transcriptHash, nodeA, nodeB);
    const { inner, sentA } = recordingPipe();
    const scA = new SecureChannelLink(inner[0], {
      ...keys,
      ...secureChannelDirections('initiator'),
    });
    const received: Uint8Array[] = [];
    const scB = new SecureChannelLink(inner[1], {
      sendKey: keys.recvKey,
      recvKey: keys.sendKey,
      ...secureChannelDirections('acceptor'),
    });
    scB.onData((bytes) => received.push(bytes.slice()));
    const large = encodeFrame({
      streamId: 1,
      op: FrameOp.DATA,
      payload: new Uint8Array(1024 * 1024).fill(1),
    });
    const tiny = encodeFrame({
      streamId: 1,
      op: FrameOp.DATA,
      payload: new Uint8Array([7]),
    });
    await Promise.all([scA.send(large), scA.send(tiny)]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sentA).toHaveLength(2);
    const first = sentA[0];
    const second = sentA[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error('expected two wire frames');
    expect(first.byteLength).toBeGreaterThan(second.byteLength);
    const recvKey = await crypto.subtle.importKey(
      'raw',
      keys.sendKey as unknown as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const firstHeader = first.slice(0, FRAME_HEADER_SIZE);
    const secondHeader = second.slice(0, FRAME_HEADER_SIZE);
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buildAesGcmNonce(SC_DIRECTION_INITIATOR, 0n) as unknown as BufferSource,
        additionalData: firstHeader as unknown as BufferSource,
        tagLength: 128,
      },
      recvKey,
      first.slice(FRAME_HEADER_SIZE) as unknown as BufferSource
    );
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buildAesGcmNonce(SC_DIRECTION_INITIATOR, 1n) as unknown as BufferSource,
        additionalData: secondHeader as unknown as BufferSource,
        tagLength: 128,
      },
      recvKey,
      second.slice(FRAME_HEADER_SIZE) as unknown as BufferSource
    );
    expect(received).toHaveLength(2);
    expect(received[0]?.byteLength).toBeGreaterThan(received[1]?.byteLength ?? 0);
  });

  it('closes the channel and rejects the rest of the queue on send failure', async () => {
    const keys = deriveSecureChannelKeys(sharedSecret, transcriptHash, nodeA, nodeB);
    const [rawA] = createBytePipe();
    let sends = 0;
    const inner: ByteTransport = {
      send(bytes) {
        sends += 1;
        if (sends >= 2) throw new Error('boom');
        return rawA.send(bytes);
      },
      onData(cb) {
        rawA.onData(cb);
      },
      onClose(cb) {
        rawA.onClose(cb);
      },
      close(reason) {
        rawA.close(reason);
      },
    };
    const sc = new SecureChannelLink(inner, {
      ...keys,
      ...secureChannelDirections('initiator'),
    });
    const closed = new Promise<string | undefined>((resolve) => sc.onClose(resolve));
    const frame = encodeFrame({ streamId: 1, op: FrameOp.DATA, payload: new Uint8Array([1]) });
    const p1 = sc.send(frame);
    const p2 = sc.send(frame);
    const p3 = sc.send(frame);
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).rejects.toBeDefined();
    await expect(p3).rejects.toBeDefined();
    expect(await closed).toBeDefined();
    await expect(sc.send(frame)).rejects.toMatchObject({ code: 'closed' });
  });
});
