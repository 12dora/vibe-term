import { wsBorsh } from '@tmex/shared';

/** 未就绪待发队列的缺省字节预算：足够一次大粘贴，仍有上限。 */
export const DEFAULT_MAX_PENDING_BYTES = 2 * 1024 * 1024;
/** 未就绪待发队列的缺省帧数上限；原先 100 在分片粘贴时过紧。 */
export const DEFAULT_MAX_PENDING_FRAMES = 2048;

export type PendingFrame = { kind: number; payload: Uint8Array };

export type PendingOverflowInfo = {
  kind: number;
  pendingFrames: number;
  pendingBytes: number;
  droppedFrames: number;
};

export type PendingEnqueueResult = {
  status: 'queued' | 'overflow';
  info?: PendingOverflowInfo;
};

export type PendingSendQueueOptions = {
  maxBytes?: number;
  maxFrames?: number;
};

/** 键盘/粘贴分片构成有序字节流：丢掉中间任何一帧都会把后续输入写进错误位置。 */
export function isOrderedInputKind(kind: number): boolean {
  return kind === wsBorsh.KIND_TERM_INPUT || kind === wsBorsh.KIND_TERM_PASTE;
}

export class PendingSendQueue {
  private readonly maxBytes: number;
  private readonly maxFrames: number;
  private frames: PendingFrame[] = [];
  private bytes = 0;
  private episodeOpen = false;
  private inputAborted = false;

  constructor(options: PendingSendQueueOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_PENDING_BYTES;
    this.maxFrames = options.maxFrames ?? DEFAULT_MAX_PENDING_FRAMES;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get pendingBytes(): number {
    return this.bytes;
  }

  enqueue(kind: number, payload: Uint8Array): PendingEnqueueResult {
    if (isOrderedInputKind(kind) && this.inputAborted) {
      return { status: 'overflow' };
    }
    if (this.fits(payload)) {
      this.frames.push({ kind, payload });
      this.bytes += payload.byteLength;
      return { status: 'queued' };
    }
    return this.rejectOverflow(kind);
  }

  drain(): PendingFrame[] {
    const out = this.frames;
    this.frames = [];
    this.bytes = 0;
    this.episodeOpen = false;
    this.inputAborted = false;
    return out;
  }

  private fits(payload: Uint8Array): boolean {
    return this.frames.length < this.maxFrames && this.bytes + payload.byteLength <= this.maxBytes;
  }

  private rejectOverflow(kind: number): PendingEnqueueResult {
    let droppedFrames = 0;
    if (isOrderedInputKind(kind)) {
      droppedFrames = this.dropOrderedInput();
      this.inputAborted = true;
    }
    if (this.episodeOpen) {
      return { status: 'overflow' };
    }
    this.episodeOpen = true;
    return {
      status: 'overflow',
      info: {
        kind,
        pendingFrames: this.frames.length,
        pendingBytes: this.bytes,
        droppedFrames,
      },
    };
  }

  private dropOrderedInput(): number {
    const kept: PendingFrame[] = [];
    let dropped = 0;
    let bytes = 0;
    for (const frame of this.frames) {
      if (isOrderedInputKind(frame.kind)) {
        dropped += 1;
        continue;
      }
      kept.push(frame);
      bytes += frame.payload.byteLength;
    }
    this.frames = kept;
    this.bytes = bytes;
    return dropped;
  }
}
