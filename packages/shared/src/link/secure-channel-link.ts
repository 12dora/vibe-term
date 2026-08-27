import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { FrameDecoder, encodeFrameHeader, writeU32LE } from './codec';
import {
  AES_GCM_IV_LENGTH,
  type ByteTransport,
  FRAME_HEADER_SIZE,
  type Frame,
  GCM_TAG_LENGTH,
  LinkError,
  type LinkRole,
  type LinkStream,
  MAX_FRAME_PAYLOAD,
  SC_DIRECTION_ACCEPTOR,
  SC_DIRECTION_INITIATOR,
  SC_KEY_LENGTH,
  SC_REKEY_COUNTER,
} from './types';

const HKDF_INFO_PREFIX = new TextEncoder().encode('tmex-sc/v1/');

/** WebCrypto BufferSource is typed against ArrayBuffer, not ArrayBufferLike. */
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}
const HKDF_INFO_ARROW = new TextEncoder().encode('->');
const AES_GCM = { name: 'AES-GCM' } as const;

export type SecureChannelKeys = {
  sendKey: Uint8Array;
  recvKey: Uint8Array;
};

export type SecureChannelOptions = {
  sendKey: Uint8Array;
  recvKey: Uint8Array;
  sendDirection: number;
  recvDirection: number;
  /** Test hook: start the send counter at this value. */
  sendCounter?: bigint;
  recvCounter?: bigint;
};

export type SecureChannelDirections = {
  sendDirection: number;
  recvDirection: number;
};

export function secureChannelDirections(role: LinkRole): SecureChannelDirections {
  if (role === 'initiator') {
    return {
      sendDirection: SC_DIRECTION_INITIATOR,
      recvDirection: SC_DIRECTION_ACCEPTOR,
    };
  }
  return {
    sendDirection: SC_DIRECTION_ACCEPTOR,
    recvDirection: SC_DIRECTION_INITIATOR,
  };
}

function concatParts(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function requireKey(name: string, key: Uint8Array): Uint8Array {
  if (key.byteLength !== SC_KEY_LENGTH) {
    throw new LinkError('protocol', `${name} must be ${SC_KEY_LENGTH} bytes`);
  }
  return key.slice();
}

function toNodeIdBytes(id: Uint8Array | string): Uint8Array {
  return typeof id === 'string' ? new TextEncoder().encode(id) : id;
}

/**
 * Derive per-direction AES-256-GCM keys.
 *
 * `k = HKDF-SHA-256(ss, salt = transcriptHash, info = "tmex-sc/v1/" ‖ sender ‖ "->" ‖ receiver, 32)`
 *
 * `sendKey` uses (senderNodeId → receiverNodeId); `recvKey` uses the swapped pair.
 * Node ids are raw bytes (16-byte node_id) or UTF-8 if a string is passed.
 */
export function deriveSecureChannelKeys(
  sharedSecret: Uint8Array,
  transcriptHash: Uint8Array,
  senderNodeId: Uint8Array | string,
  receiverNodeId: Uint8Array | string
): SecureChannelKeys {
  const sender = toNodeIdBytes(senderNodeId);
  const receiver = toNodeIdBytes(receiverNodeId);
  const sendInfo = concatParts([HKDF_INFO_PREFIX, sender, HKDF_INFO_ARROW, receiver]);
  const recvInfo = concatParts([HKDF_INFO_PREFIX, receiver, HKDF_INFO_ARROW, sender]);
  return {
    sendKey: hkdf(sha256, sharedSecret, transcriptHash, sendInfo, SC_KEY_LENGTH),
    recvKey: hkdf(sha256, sharedSecret, transcriptHash, recvInfo, SC_KEY_LENGTH),
  };
}

export function x25519SharedSecret(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(sk, pk);
}

/** nonce = u32 direction (LE) ‖ u64 counter (LE) */
export function buildAesGcmNonce(direction: number, counter: bigint): Uint8Array {
  const nonce = new Uint8Array(AES_GCM_IV_LENGTH);
  writeU32LE(nonce, 0, direction >>> 0);
  writeU32LE(nonce, 4, Number(counter & 0xffffffffn));
  writeU32LE(nonce, 8, Number((counter >> 32n) & 0xffffffffn));
  return nonce;
}

export function byteTransportFromStream(stream: LinkStream): ByteTransport {
  let reading = false;
  const dataCbs: Array<(bytes: Uint8Array) => void> = [];
  const closeCbs: Array<(reason?: string) => void> = [];
  let closed = false;

  const startRead = () => {
    if (reading) return;
    reading = true;
    const reader = stream.readable.getReader();
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            for (const cb of dataCbs) cb(value.bytes);
          }
        }
      } catch {
        // stream aborted
      } finally {
        if (!closed) {
          closed = true;
          for (const cb of closeCbs) cb('stream-closed');
        }
      }
    })();
  };

  stream.onAbort(() => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb('stream-aborted');
  });
  void stream.closed.then((info) => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb(info.message ?? info.reason);
  });

  return {
    send(bytes) {
      return stream.write(bytes);
    },
    onData(cb) {
      dataCbs.push(cb);
      startRead();
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    close(reason) {
      if (closed) return;
      closed = true;
      stream.reset(reason);
    },
  };
}

/**
 * Encrypts/decrypts mux frames over an inner byte transport (typically a hub relay stream).
 *
 * Interop / wire format (per encrypted mux frame):
 *   `[streamId u32 LE][op u8][flags u8][len u32 LE][ciphertext][tag 16]`
 *   `len` = ciphertext length + tag (16) = plaintext payload length + 16
 *   AAD = the 10-byte **wire** header actually sent (with that `len`)
 *   nonce = u32 direction LE ‖ u64 counter LE
 *   ciphertext‖tag is WebCrypto AES-256-GCM output (`tagLength: 128`)
 *
 * Decrypt uses the received wire header as AAD, then rebuilds a plaintext
 * mux header with `len = plaintext.length` before handing bytes to LinkMux.
 *
 * Send path is a link-level queue: assign counter → encrypt → inner.send
 * run serially so wire order equals counter order. Any encrypt/send failure
 * closes the channel and rejects the rest of the queue.
 */
export class SecureChannelLink implements ByteTransport {
  private readonly inner: ByteTransport;
  private readonly sendDirection: number;
  private readonly recvDirection: number;
  private readonly decoder = new FrameDecoder({
    maxPayload: MAX_FRAME_PAYLOAD + GCM_TAG_LENGTH,
  });
  private readonly outbound = new FrameDecoder({ maxPayload: MAX_FRAME_PAYLOAD });
  private readonly dataCbs: Array<(bytes: Uint8Array) => void> = [];
  private readonly closeCbs: Array<(reason?: string) => void> = [];
  private readonly rekeyCbs: Array<() => void> = [];
  private sendCounter: bigint;
  private recvCounter: bigint;
  private sendKey!: CryptoKey;
  private recvKey!: CryptoKey;
  private readonly ready: Promise<void>;
  private closed = false;
  private rekeyFired = false;
  private decrypting = false;
  private readonly pendingIncoming: Uint8Array[] = [];
  private sendChain: Promise<void> = Promise.resolve();

  constructor(inner: ByteTransport, opts: SecureChannelOptions) {
    this.inner = inner;
    this.sendDirection = opts.sendDirection >>> 0;
    this.recvDirection = opts.recvDirection >>> 0;
    this.sendCounter = opts.sendCounter ?? 0n;
    this.recvCounter = opts.recvCounter ?? 0n;
    const sendRaw = requireKey('sendKey', opts.sendKey);
    const recvRaw = requireKey('recvKey', opts.recvKey);
    this.ready = this.importKeys(sendRaw, recvRaw);

    inner.onData((bytes) => {
      this.pendingIncoming.push(bytes);
      void this.drainIncoming();
    });
    inner.onClose((reason) => {
      this.finishClose(reason);
    });
  }

  onRekeyNeeded(cb: () => void): void {
    if (this.rekeyFired) {
      cb();
      return;
    }
    this.rekeyCbs.push(cb);
  }

  send(bytes: Uint8Array): Promise<void> {
    const run = this.sendChain.then(() => this.sendSerialized(bytes));
    this.sendChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCbs.push(cb);
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCbs.push(cb);
  }

  close(reason?: string): void {
    this.finishClose(reason);
  }

  private async sendSerialized(bytes: Uint8Array): Promise<void> {
    await this.ready;
    if (this.closed) {
      throw new LinkError('closed', 'secure channel is closed');
    }
    const frames = this.outbound.push(bytes);
    try {
      for (const frame of frames) {
        if (this.sendCounter >= SC_REKEY_COUNTER) {
          this.fireRekey();
          throw new LinkError('rekey', 'secure channel rekey required');
        }
        const wireLen = frame.payload.byteLength + GCM_TAG_LENGTH;
        const wireHeader = encodeFrameHeader(frame.streamId, frame.op, frame.flags, wireLen);
        const nonce = buildAesGcmNonce(this.sendDirection, this.sendCounter);
        this.sendCounter += 1n;
        const ciphertext = new Uint8Array(
          await crypto.subtle.encrypt(
            {
              name: 'AES-GCM',
              iv: asBufferSource(nonce),
              additionalData: asBufferSource(wireHeader),
              tagLength: 128,
            },
            this.sendKey,
            asBufferSource(frame.payload)
          )
        );
        const wire = new Uint8Array(FRAME_HEADER_SIZE + ciphertext.byteLength);
        wire.set(wireHeader, 0);
        wire.set(ciphertext, FRAME_HEADER_SIZE);
        await this.inner.send(wire);
      }
    } catch (err) {
      if (err instanceof LinkError && err.code === 'rekey') throw err;
      const message = err instanceof Error ? err.message : 'secure send failed';
      this.finishClose(message);
      throw err instanceof LinkError ? err : new LinkError('closed', message);
    }
  }

  private async importKeys(sendRaw: Uint8Array, recvRaw: Uint8Array): Promise<void> {
    this.sendKey = await crypto.subtle.importKey('raw', asBufferSource(sendRaw), AES_GCM, false, [
      'encrypt',
    ]);
    this.recvKey = await crypto.subtle.importKey('raw', asBufferSource(recvRaw), AES_GCM, false, [
      'decrypt',
    ]);
  }

  private async drainIncoming(): Promise<void> {
    if (this.decrypting) return;
    this.decrypting = true;
    try {
      await this.ready;
      while (this.pendingIncoming.length > 0 && !this.closed) {
        const chunk = this.pendingIncoming.shift();
        if (!chunk) break;
        let frames: Frame[];
        try {
          frames = this.decoder.push(chunk);
        } catch (err) {
          this.finishClose(err instanceof Error ? err.message : 'secure decode error');
          return;
        }
        for (const frame of frames) {
          try {
            const plaintext = await this.decryptFrame(
              frame.streamId,
              frame.op,
              frame.flags,
              frame.payload
            );
            for (const cb of this.dataCbs) cb(plaintext);
          } catch (err) {
            this.finishClose(err instanceof Error ? err.message : 'decrypt failed');
            return;
          }
        }
      }
    } finally {
      this.decrypting = false;
    }
  }

  private async decryptFrame(
    streamId: number,
    op: number,
    flags: number,
    ciphertextAndTag: Uint8Array
  ): Promise<Uint8Array> {
    if (ciphertextAndTag.byteLength < GCM_TAG_LENGTH) {
      throw new LinkError('protocol', 'secure frame shorter than GCM tag');
    }
    const wireHeader = encodeFrameHeader(streamId, op, flags, ciphertextAndTag.byteLength);
    const nonce = buildAesGcmNonce(this.recvDirection, this.recvCounter);
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: asBufferSource(nonce),
          additionalData: asBufferSource(wireHeader),
          tagLength: 128,
        },
        this.recvKey,
        asBufferSource(ciphertextAndTag)
      )
    );
    this.recvCounter += 1n;
    const ptHeader = encodeFrameHeader(streamId, op, flags, plaintext.byteLength);
    const out = new Uint8Array(FRAME_HEADER_SIZE + plaintext.byteLength);
    out.set(ptHeader, 0);
    out.set(plaintext, FRAME_HEADER_SIZE);
    return out;
  }

  private fireRekey(): void {
    if (this.rekeyFired) return;
    this.rekeyFired = true;
    for (const cb of this.rekeyCbs) {
      try {
        cb();
      } catch {
        // listener errors must not break the channel
      }
    }
  }

  private finishClose(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.inner.close(reason);
    } catch {
      // inner already closed
    }
    for (const cb of this.closeCbs) {
      try {
        cb(reason);
      } catch {
        // listener errors must not break the channel
      }
    }
  }
}

export { SC_DIRECTION_ACCEPTOR, SC_DIRECTION_INITIATOR, SC_REKEY_COUNTER };
