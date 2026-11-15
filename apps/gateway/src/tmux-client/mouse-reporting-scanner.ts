import { type MouseTracking, type PaneMouseState, unknownMouseState } from './pane-mouse-state';

const trackingModes = new Map<number, MouseTracking>([
  [1000, 'normal'],
  [1002, 'button'],
  [1003, 'any'],
]);
const SYNCHRONIZED_OUTPUT_MODE = 2026;
const SGR_MODE = 1006;
const UTF8_MODE = 1005;
const URXVT_MODE = 1015;

export class MouseReportingScanner {
  private sequence = '';
  readonly state: PaneMouseState = unknownMouseState();
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

  /** 返回本段输出是否关掉了鼠标上报（DECRST 任一追踪模式或 RIS） */
  push(bytes: Uint8Array): boolean {
    let disabled = false;
    for (const byte of bytes) {
      if (byte === 0x1b) {
        this.sequence = '\x1b';
      } else if (this.sequence) {
        this.sequence += String.fromCharCode(byte);
        if (this.sequence.length === 2 && byte === 0x5b) continue;
        if (byte >= 0x40 && byte <= 0x7e) {
          disabled = this.apply(this.sequence.slice(1)) || disabled;
          this.sequence = '';
        } else if (this.sequence.length > 128) {
          this.sequence = '';
        }
      }
    }
    return disabled;
  }

  private apply(body: string): boolean {
    if (body === 'c') {
      this.reset();
      return true;
    }
    // tmux 的 DECSTR 不动鼠标模式：只作废已知状态，等下一次标志校准
    if (body === '[!p') {
      this.state.known = false;
      this.state.verifiedAt = null;
      return false;
    }
    const match = /^\[\?([\d;]+)([hl])$/.exec(body);
    if (!match) return false;
    let disabled = false;
    for (const value of match[1].split(';')) {
      disabled = this.applyMode(Number(value), match[2] === 'h') || disabled;
    }
    return disabled;
  }

  private applyMode(mode: number, set: boolean): boolean {
    if (mode === SYNCHRONIZED_OUTPUT_MODE) {
      if (set) this.insideFrame = true;
      else {
        this.frameEnd = true;
        this.insideFrame = false;
      }
      return false;
    }
    if (mode === SGR_MODE) this.state.sgr = set;
    else if (mode === UTF8_MODE) this.state.utf8 = set;
    else if (mode === URXVT_MODE) this.state.urxvt = set;
    const tracking = trackingModes.get(mode);
    if (!tracking) return false;
    // 与 tmux 一致：开启任一追踪模式互斥替换，关闭任一追踪模式即全部关闭
    this.state.tracking = set ? tracking : 'none';
    this.state.known = true;
    return !set;
  }

  private reset(): void {
    Object.assign(this.state, unknownMouseState(), {
      known: true,
      verifiedAt: this.state.verifiedAt,
    });
  }
}
