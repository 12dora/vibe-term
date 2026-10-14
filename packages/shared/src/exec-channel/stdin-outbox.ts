import { EC_CHUNK_BYTES } from './constants';

type Piece = { start: number; bytes: Uint8Array };

const COMPACT_THRESHOLD = 256;
const RELEASED = new Uint8Array(0);

export class StdinOutbox {
  private pieces: Piece[] = [];
  private head = 0;
  private sentOffset = 0;
  private ackedOffset = 0;

  get sent(): number {
    return this.sentOffset;
  }

  get acked(): number {
    return this.ackedOffset;
  }

  get unacked(): number {
    return this.sentOffset - this.ackedOffset;
  }

  push(bytes: Uint8Array): number {
    if (bytes.byteLength === 0) return this.sentOffset;
    this.pieces.push({ start: this.sentOffset, bytes });
    this.sentOffset += bytes.byteLength;
    return this.sentOffset;
  }

  ack(offset: number): boolean {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.sentOffset) return false;
    if (offset <= this.ackedOffset) return true;
    this.ackedOffset = offset;
    this.dropAcked();
    return true;
  }

  pendingFrom(offset: number): Uint8Array[] | null {
    if (!Number.isSafeInteger(offset) || offset < this.ackedOffset || offset > this.sentOffset) {
      return null;
    }
    const out: Uint8Array[] = [];
    for (let i = this.head; i < this.pieces.length; i += 1) {
      const piece = this.pieces[i] as Piece;
      const skip = Math.max(0, offset - piece.start);
      if (skip >= piece.bytes.byteLength) continue;
      appendChunks(out, piece.bytes.subarray(skip));
    }
    return out;
  }

  private dropAcked(): void {
    while (this.head < this.pieces.length) {
      const piece = this.pieces[this.head] as Piece;
      const end = piece.start + piece.bytes.byteLength;
      if (end <= this.ackedOffset) {
        piece.bytes = RELEASED;
        this.head += 1;
        continue;
      }
      const skip = this.ackedOffset - piece.start;
      if (skip > 0) {
        this.pieces[this.head] = { start: this.ackedOffset, bytes: piece.bytes.subarray(skip) };
      }
      break;
    }
    if (this.head >= COMPACT_THRESHOLD && this.head * 2 >= this.pieces.length) {
      this.pieces = this.pieces.slice(this.head);
      this.head = 0;
    }
  }
}

function appendChunks(out: Uint8Array[], bytes: Uint8Array): void {
  for (let pos = 0; pos < bytes.byteLength; pos += EC_CHUNK_BYTES) {
    out.push(bytes.subarray(pos, Math.min(pos + EC_CHUNK_BYTES, bytes.byteLength)));
  }
}
