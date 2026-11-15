import { MOUSE_TRACKING_MODES } from './terminal-constants';

export type MouseTrackingChange = { mode: number; enabled: boolean };

type ScanState = 'ground' | 'esc' | 'csi' | 'params';

const ESC = 0x1b;
const LEFT_BRACKET = 0x5b;
const QUESTION = 0x3f;
const SEMICOLON = 0x3b;
const LOWER_H = 0x68;
const LOWER_L = 0x6c;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const MAX_PARAM = 99_999;
const MAX_PARAMS = 16;

const encoder = new TextEncoder();

// 流式扫描 `CSI ? Pm h|l`，只关心鼠标跟踪模式（9/1000/1002/1003）。
// xterm 语义下这几个模式互斥：任意一个被 DECRST 即整体关闭，DECSET 则切换为该模式；
// WASM 内核按位独立记录，所以由这里报告一段输出的「最终净效果」，交给桥接层纠正。
export class MouseTrackingScanner {
  private state: ScanState = 'ground';
  private param = 0;
  private hasDigits = false;
  private params: number[] = [];

  reset(): void {
    this.state = 'ground';
    this.clearParams();
  }

  feed(data: string | Uint8Array): MouseTrackingChange | null {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    let last: MouseTrackingChange | null = null;
    let index = 0;
    while (index < bytes.length) {
      if (this.state === 'ground') {
        const next = bytes.indexOf(ESC, index);
        if (next < 0) {
          break;
        }
        this.state = 'esc';
        index = next + 1;
        continue;
      }
      last = this.step(bytes[index] as number) ?? last;
      index += 1;
    }
    return last;
  }

  private step(byte: number): MouseTrackingChange | null {
    if (byte === ESC) {
      this.state = 'esc';
      this.clearParams();
      return null;
    }
    if (this.state === 'esc') {
      this.state = byte === LEFT_BRACKET ? 'csi' : 'ground';
      return null;
    }
    if (this.state === 'csi') {
      this.state = byte === QUESTION ? 'params' : 'ground';
      return null;
    }
    return this.stepParams(byte);
  }

  private stepParams(byte: number): MouseTrackingChange | null {
    if (byte >= DIGIT_0 && byte <= DIGIT_9) {
      this.param = Math.min(MAX_PARAM, this.param * 10 + (byte - DIGIT_0));
      this.hasDigits = true;
      return null;
    }
    if (byte === SEMICOLON) {
      this.pushParam();
      return null;
    }
    if (byte !== LOWER_H && byte !== LOWER_L) {
      this.state = 'ground';
      this.clearParams();
      return null;
    }
    this.pushParam();
    const enabled = byte === LOWER_H;
    const tracking = this.params.filter((mode) => MOUSE_TRACKING_MODES.includes(mode));
    this.state = 'ground';
    this.clearParams();
    const mode = tracking[tracking.length - 1];
    return mode === undefined ? null : { mode, enabled };
  }

  private pushParam(): void {
    if (this.params.length < MAX_PARAMS) {
      this.params.push(this.hasDigits ? this.param : 0);
    }
    this.param = 0;
    this.hasDigits = false;
  }

  private clearParams(): void {
    this.param = 0;
    this.hasDigits = false;
    this.params = [];
  }
}
