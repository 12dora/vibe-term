const reportingModes = new Set([1000, 1002, 1003]);
const SYNCHRONIZED_OUTPUT_MODE = 2026;

export class MouseReportingScanner {
  private sequence = '';
  private readonly enabled = new Set<number>();
  /** 自上次 takeFrameEnd() 起是否见过 DEC 2026 同步输出结束（应用完成一帧、回到读循环） */
  private frameEnd = false;
  private insideFrame = false;

  /** 应用正处于 DEC 2026 同步帧之中（见过 h 尚未见到 l）：此时的输出只是半帧，不能当作已消费上一条 */
  get inFrame(): boolean {
    return this.insideFrame;
  }

  takeFrameEnd(): boolean {
    const seen = this.frameEnd;
    this.frameEnd = false;
    return seen;
  }

  push(bytes: Uint8Array): boolean {
    let disabled = false;
    for (const byte of bytes) {
      if (byte === 0x1b) {
        this.sequence = '\x1b';
      } else if (this.sequence) {
        this.sequence += String.fromCharCode(byte);
        if (this.sequence.length === 2 && byte === 0x5b) continue;
        if (byte >= 0x40 && byte <= 0x7e) {
          disabled = this.apply() || disabled;
          this.sequence = '';
        } else if (this.sequence.length > 128) {
          this.sequence = '';
        }
      }
    }
    return disabled;
  }

  private apply(): boolean {
    const match = /^\[\?([\d;]+)([hl])$/.exec(this.sequence.slice(1));
    if (!match) return false;
    let reset = false;
    for (const value of match[1].split(';')) {
      const mode = Number(value);
      if (mode === SYNCHRONIZED_OUTPUT_MODE) {
        if (match[2] === 'l') {
          this.frameEnd = true;
          this.insideFrame = false;
        } else {
          this.insideFrame = true;
        }
        continue;
      }
      if (!reportingModes.has(mode)) continue;
      if (match[2] === 'h') this.enabled.add(mode);
      else {
        this.enabled.delete(mode);
        reset = true;
      }
    }
    // 连接可能在应用开启模式后才建立，首次看到 reset 也要清掉旧输入。
    return reset && this.enabled.size === 0;
  }
}
