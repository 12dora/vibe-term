type Entry = { start: number; bytes: Uint8Array };

const COMPACT_THRESHOLD = 256;
const RELEASED = new Uint8Array(0);

export class OutputLog {
  private entries: Entry[] = [];
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

  append(frameBytes: Uint8Array): number {
    this.entries.push({ start: this.sentOffset, bytes: frameBytes });
    this.sentOffset += frameBytes.byteLength;
    return this.sentOffset;
  }

  sliceFrom(offset: number): Uint8Array[] | null {
    if (!Number.isSafeInteger(offset) || offset < this.ackedOffset || offset > this.sentOffset) {
      return null;
    }
    if (offset === this.sentOffset) return [];
    const index = this.indexOfStart(offset);
    if (index < 0) return null;
    return this.entries.slice(index).map((entry) => entry.bytes);
  }

  ack(offset: number): boolean {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.sentOffset) return false;
    if (offset <= this.ackedOffset) return true;
    this.ackedOffset = offset;
    this.dropAcked();
    return true;
  }

  private indexOfStart(offset: number): number {
    let low = this.head;
    let high = this.entries.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const start = (this.entries[mid] as Entry).start;
      if (start === offset) return mid;
      if (start < offset) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  }

  private dropAcked(): void {
    while (this.head < this.entries.length) {
      const entry = this.entries[this.head] as Entry;
      if (entry.start + entry.bytes.byteLength > this.ackedOffset) break;
      entry.bytes = RELEASED;
      this.head += 1;
    }
    if (this.head >= COMPACT_THRESHOLD && this.head * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
  }
}
