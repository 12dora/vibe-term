// TTY 回放过滤器：丢掉会污染操作员终端的查询/剪贴板序列，保留画屏用的 SGR/光标/擦除/备用屏。
// 序列可能被切在 chunk 边界上，所以是有状态的。

const ESC = 0x1b;
const BEL = 0x07;
const ST_C1 = 0x9c;
const CSI_C1 = 0x9b;
const OSC_C1 = 0x9d;
const DCS_C1 = 0x90;
const SOS_C1 = 0x98;
const PM_C1 = 0x9e;
const APC_C1 = 0x9f;

export const REPLAY_TTY_RESTORE =
  '\x1b[0m\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l';

export const REPLAY_TTY_RESTORE_BYTES = new TextEncoder().encode(REPLAY_TTY_RESTORE);

type Mode = 'ground' | 'esc' | 'csi' | 'osc' | 'osc-esc' | 'str' | 'str-esc';

interface EnteredModes {
  alt: boolean;
  cursorHidden: boolean;
  mouse: boolean;
  paste: boolean;
}

function csiBodyStart(buf: readonly number[]): number {
  return buf[0] === ESC ? 2 : 1;
}

function oscAllowed(body: readonly number[]): boolean {
  const first = body[0];
  if (first !== 0x30 && first !== 0x31 && first !== 0x32) return false;
  return body.length === 1 || body[1] === 0x3b;
}

function csiIsQuery(buf: readonly number[]): boolean {
  const final = buf[buf.length - 1];
  if (final === 0x63 || final === 0x6e) return true;
  if (final !== 0x70) return false;
  const start = csiBodyStart(buf);
  for (let index = start; index < buf.length - 1; index += 1) {
    if (buf[index] === 0x24) return true;
  }
  return false;
}

function isMouseMode(mode: number): boolean {
  return mode === 1000 || mode === 1002 || mode === 1003 || mode === 1006;
}

function applyPrivateMode(mode: number, set: boolean, entered: EnteredModes): void {
  if (mode === 1049 && set) entered.alt = true;
  if (mode === 25 && !set) entered.cursorHidden = true;
  if (isMouseMode(mode) && set) entered.mouse = true;
  if (mode === 2004 && set) entered.paste = true;
}

function trackPrivateModes(buf: readonly number[], entered: EnteredModes): void {
  const final = buf[buf.length - 1];
  if (final !== 0x68 && final !== 0x6c) return;
  const start = csiBodyStart(buf);
  if (buf[start] !== 0x3f) return;
  const set = final === 0x68;
  const text = String.fromCharCode(...buf.slice(start + 1, -1));
  for (const part of text.split(';')) applyPrivateMode(Number(part), set, entered);
}

function oscBody(buf: readonly number[]): number[] {
  const start = buf[0] === ESC ? 2 : 1;
  const last = buf[buf.length - 1];
  if (last === BEL || last === ST_C1) return buf.slice(start, -1);
  return buf.slice(start, -2);
}

export class ReplayVtFilter {
  private mode: Mode = 'ground';
  private buf: number[] = [];
  private readonly entered: EnteredModes = {
    alt: false,
    cursorHidden: false,
    mouse: false,
    paste: false,
  };

  needsRestore(): boolean {
    const { alt, cursorHidden, mouse, paste } = this.entered;
    return alt || cursorHidden || mouse || paste;
  }

  restoreBytes(): Uint8Array {
    return REPLAY_TTY_RESTORE_BYTES;
  }

  push(input: Uint8Array): Uint8Array {
    const out: number[] = [];
    for (let index = 0; index < input.length; index += 1) this.consume(input[index], out);
    return Uint8Array.from(out);
  }

  flush(): Uint8Array {
    this.mode = 'ground';
    this.buf = [];
    return new Uint8Array(0);
  }

  private consume(byte: number, out: number[]): void {
    if (this.mode === 'ground') this.consumeGround(byte, out);
    else if (this.mode === 'esc') this.consumeEsc(byte, out);
    else if (this.mode === 'csi') this.consumeCsi(byte, out);
    else if (this.mode === 'osc' || this.mode === 'osc-esc') this.consumeOsc(byte, out);
    else this.consumeStr(byte);
  }

  private consumeGround(byte: number, out: number[]): void {
    if (byte === ESC) {
      this.mode = 'esc';
      this.buf = [byte];
      return;
    }
    if (byte === CSI_C1) {
      this.mode = 'csi';
      this.buf = [byte];
      return;
    }
    if (byte === OSC_C1) {
      this.mode = 'osc';
      this.buf = [byte];
      return;
    }
    if (byte === DCS_C1 || byte === SOS_C1 || byte === PM_C1 || byte === APC_C1) {
      this.mode = 'str';
      this.buf = [byte];
      return;
    }
    out.push(byte);
  }

  private consumeEsc(byte: number, out: number[]): void {
    this.buf.push(byte);
    if (byte === 0x5b) {
      this.mode = 'csi';
      return;
    }
    if (byte === 0x5d) {
      this.mode = 'osc';
      return;
    }
    if (byte === 0x50 || byte === 0x58 || byte === 0x5e || byte === 0x5f) {
      this.mode = 'str';
      return;
    }
    out.push(...this.buf);
    this.buf = [];
    this.mode = 'ground';
  }

  private consumeCsi(byte: number, out: number[]): void {
    if (byte === ESC) {
      this.buf = [ESC];
      this.mode = 'esc';
      return;
    }
    this.buf.push(byte);
    if (byte >= 0x40 && byte <= 0x7e) {
      this.finishCsi(out);
      this.buf = [];
      this.mode = 'ground';
      return;
    }
    if (byte < 0x20 || byte > 0x3f) {
      this.buf = [];
      this.mode = 'ground';
    }
  }

  private finishCsi(out: number[]): void {
    if (csiIsQuery(this.buf)) return;
    trackPrivateModes(this.buf, this.entered);
    out.push(...this.buf);
  }

  private consumeOsc(byte: number, out: number[]): void {
    if (this.mode === 'osc-esc') {
      this.buf.push(byte);
      if (byte === 0x5c) this.finishOsc(out);
      else this.mode = 'osc';
      return;
    }
    this.buf.push(byte);
    if (byte === BEL || byte === ST_C1) {
      this.finishOsc(out);
      return;
    }
    if (byte === ESC) this.mode = 'osc-esc';
  }

  private finishOsc(out: number[]): void {
    if (oscAllowed(oscBody(this.buf))) out.push(...this.buf);
    this.buf = [];
    this.mode = 'ground';
  }

  private consumeStr(byte: number): void {
    if (this.mode === 'str-esc') {
      if (byte === 0x5c || byte === ESC) {
        if (byte === 0x5c) {
          this.buf = [];
          this.mode = 'ground';
        }
        return;
      }
      this.mode = 'str';
      return;
    }
    if (byte === BEL || byte === ST_C1) {
      this.buf = [];
      this.mode = 'ground';
      return;
    }
    if (byte === ESC) this.mode = 'str-esc';
  }
}
