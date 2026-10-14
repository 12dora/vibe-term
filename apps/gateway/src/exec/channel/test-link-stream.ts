import {
  LinkError,
  type LinkStream,
  type StreamChunk,
  type StreamCloseInfo,
} from '@vibeterm/shared/link';

type Controller = ReadableStreamDefaultController<StreamChunk>;

/** 可控的 LinkStream 替身：写可以被门闸卡住，读是拉取式，RST 与 END 由测试注入。 */
export class FakeLinkStream implements LinkStream {
  readonly id = 1;
  readonly readable: ReadableStream<StreamChunk>;
  readonly closed: Promise<StreamCloseInfo>;
  readonly written: Uint8Array[] = [];
  dead = false;
  ended = false;
  resetReason: string | undefined;
  pulled = 0;
  writeError: Error | null = null;
  private writeGate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;
  private readonly chunks: Uint8Array[] = [];
  private peerEnded = false;
  private failure: LinkError | null = null;
  private wake: (() => void) | null = null;
  private readonly abortCbs: Array<() => void> = [];
  private settle!: (info: StreamCloseInfo) => void;

  constructor(readonly openPayload: Uint8Array = new Uint8Array(0)) {
    this.closed = new Promise((resolve) => {
      this.settle = resolve;
    });
    this.readable = new ReadableStream<StreamChunk>(
      {
        pull: (controller) => {
          if (this.serve(controller)) return;
          return new Promise<void>((resolve) => {
            this.wake = () => {
              if (!this.serve(controller)) return;
              this.wake = null;
              resolve();
            };
          });
        },
      },
      { highWaterMark: 0 }
    );
  }

  blockWrites(): void {
    this.writeGate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
  }

  releaseWrites(): void {
    this.openGate?.();
    this.writeGate = null;
    this.openGate = null;
  }

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.wake?.();
  }

  peerEnd(): void {
    this.peerEnded = true;
    this.wake?.();
  }

  peerReset(message: string): void {
    this.abort({ reason: 'rst', message });
  }

  linkLost(): void {
    this.abort({ reason: 'link-closed', message: 'link-closed' });
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.dead) throw this.failure ?? new LinkError('closed', 'stream dead');
    if (this.writeError) throw this.writeError;
    if (this.writeGate) await this.writeGate;
    if (this.dead) throw this.failure ?? new LinkError('closed', 'stream dead');
    this.written.push(bytes);
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  reset(reason?: string): void {
    if (this.dead) return;
    this.resetReason = reason;
    this.abort({ reason: 'rst', message: reason });
  }

  onAbort(cb: () => void): void {
    if (this.dead) cb();
    else this.abortCbs.push(cb);
  }

  private abort(info: StreamCloseInfo): void {
    if (this.dead) return;
    this.dead = true;
    this.failure = new LinkError(info.reason, info.message ?? info.reason);
    this.wake?.();
    for (const cb of this.abortCbs.splice(0)) cb();
    this.settle(info);
  }

  private serve(controller: Controller): boolean {
    if (this.failure) {
      controller.error(this.failure);
      return true;
    }
    const next = this.chunks.shift();
    if (next) {
      this.pulled += 1;
      controller.enqueue({ bytes: next, head: false });
      return true;
    }
    if (!this.peerEnded) return false;
    controller.close();
    return true;
  }
}
