import type { PaneStreamParserOptions } from '../pane-stream-parser';

export const MAX_OSC_KIND_BYTES = 16;
export const MAX_OSC_PAYLOAD_BYTES = 8 * 1024;
export const MAX_TITLE_BYTES = 8 * 1024;
export const MAX_DCS_PASSTHROUGH_BYTES = 64 * 1024;
export const MAX_KITTY_PENDING_IDS = 16;
export const MAX_CSI_BYTES = 64;
export const TMUX_PASSTHROUGH_PREFIX_BYTES = new Uint8Array([0x74, 0x6d, 0x75, 0x78, 0x3b]);
export const THEME_UPDATES_MODE = '2031';
export const EMPTY_UINT8 = new Uint8Array(0);

export const utf8Decoder = new TextDecoder();

export type ParserPhase =
  | 'normal'
  | 'esc'
  | 'csi'
  | 'osc-params'
  | 'osc-body'
  | 'osc-body-ignore'
  | 'osc-st'
  | 'osc-st-ignore'
  | 'screen-title'
  | 'screen-title-st'
  | 'screen-title-ignore'
  | 'screen-title-st-ignore'
  | 'dcs-detect'
  | 'dcs-tmux'
  | 'dcs-tmux-esc'
  | 'dcs-tmux-ignore'
  | 'dcs-tmux-ignore-esc';

export type KittyPending = { title: string; body: string };

export type ParserOutput = {
  buf: Uint8Array;
  len: number;
};

export type ParserState = {
  phase: ParserPhase;
  oscKind: string;
  oscPayloadBytes: number[];
  titleBytes: number[];
  dcsPrefixLength: number;
  dcsBytes: number[];
  csiBytes: number[];
  inTmuxPassthrough: boolean;
  warnedOscPayloadOverflow: boolean;
  warnedTitleOverflow: boolean;
  warnedDcsOverflow: boolean;
  kittyPending: Map<string, KittyPending>;
  lastClipboardWrite: { text: string; at: number } | null;
};

export type ParserContext = {
  state: ParserState;
  options: PaneStreamParserOptions;
  output: ParserOutput;
  processByte: (byte: number) => void;
  pendingPassthrough: Uint8Array[];
};

export function createParserOutput(capacity: number): ParserOutput {
  return { buf: capacity > 0 ? new Uint8Array(capacity) : EMPTY_UINT8, len: 0 };
}

function growOutput(out: ParserOutput, extra: number): void {
  const needed = out.len + extra;
  let cap = out.buf.length < 256 ? 256 : out.buf.length;
  while (cap < needed) {
    cap *= 2;
  }
  const next = new Uint8Array(cap);
  if (out.len > 0) {
    next.set(out.buf.subarray(0, out.len));
  }
  out.buf = next;
}

export function writeByte(out: ParserOutput, byte: number): void {
  if (out.len >= out.buf.length) {
    growOutput(out, 1);
  }
  out.buf[out.len] = byte;
  out.len += 1;
}

export function writeBytes(out: ParserOutput, bytes: ArrayLike<number>): void {
  const n = bytes.length;
  if (n === 0) {
    return;
  }
  if (out.len + n > out.buf.length) {
    growOutput(out, n);
  }
  out.buf.set(bytes, out.len);
  out.len += n;
}

export function writeRun(out: ParserOutput, src: Uint8Array, start: number, end: number): void {
  const n = end - start;
  if (n <= 0) {
    return;
  }
  if (out.len + n > out.buf.length) {
    growOutput(out, n);
  }
  out.buf.set(src.subarray(start, end), out.len);
  out.len += n;
}

export function snapshotOutput(out: ParserOutput): number[] {
  return Array.from(out.buf.subarray(0, out.len));
}

export function takeOutput(out: ParserOutput): Uint8Array {
  if (out.len === 0) {
    return EMPTY_UINT8;
  }
  if (out.len === out.buf.length) {
    return out.buf;
  }
  return out.buf.subarray(0, out.len);
}

export function createParserState(): ParserState {
  return {
    phase: 'normal',
    oscKind: '',
    oscPayloadBytes: [],
    titleBytes: [],
    dcsPrefixLength: 0,
    dcsBytes: [],
    csiBytes: [],
    inTmuxPassthrough: false,
    warnedOscPayloadOverflow: false,
    warnedTitleOverflow: false,
    warnedDcsOverflow: false,
    kittyPending: new Map(),
    lastClipboardWrite: null,
  };
}

export function resetOscState(state: ParserState): void {
  state.oscKind = '';
  state.oscPayloadBytes = [];
}

export function resetDcsState(state: ParserState): void {
  state.dcsBytes = [];
  state.dcsPrefixLength = 0;
}

export function appendOscPayloadByte(ctx: ParserContext, byte: number): boolean {
  const { state } = ctx;
  if (state.oscPayloadBytes.length >= MAX_OSC_PAYLOAD_BYTES) {
    if (!state.warnedOscPayloadOverflow) {
      state.warnedOscPayloadOverflow = true;
      console.warn('[tmex] pane stream parser dropped oversized OSC payload');
    }
    state.oscPayloadBytes = [];
    state.phase = 'osc-body-ignore';
    return false;
  }
  state.oscPayloadBytes.push(byte);
  return true;
}

export function appendOscPayloadRun(
  ctx: ParserContext,
  src: Uint8Array,
  start: number,
  end: number
): void {
  for (let i = start; i < end; i += 1) {
    const byte = src[i];
    if (byte === undefined || !appendOscPayloadByte(ctx, byte)) {
      return;
    }
  }
}

export function appendDcsByte(ctx: ParserContext, byte: number): boolean {
  const { state } = ctx;
  if (state.dcsBytes.length >= MAX_DCS_PASSTHROUGH_BYTES) {
    if (!state.warnedDcsOverflow) {
      state.warnedDcsOverflow = true;
      console.warn('[tmex] pane stream parser dropped oversized tmux passthrough payload');
    }
    state.dcsBytes = [];
    state.phase = 'dcs-tmux-ignore';
    return false;
  }
  state.dcsBytes.push(byte);
  return true;
}

export function appendDcsRun(
  ctx: ParserContext,
  src: Uint8Array,
  start: number,
  end: number
): void {
  for (let i = start; i < end; i += 1) {
    const byte = src[i];
    if (byte === undefined || !appendDcsByte(ctx, byte)) {
      return;
    }
  }
}

export function warnTitleOverflow(state: ParserState): void {
  if (!state.warnedTitleOverflow) {
    state.warnedTitleOverflow = true;
    console.warn('[tmex] pane stream parser dropped oversized title');
  }
}

export function appendTitleRun(
  ctx: ParserContext,
  src: Uint8Array,
  start: number,
  end: number
): void {
  const { state } = ctx;
  for (let i = start; i < end; i += 1) {
    if (state.titleBytes.length >= MAX_TITLE_BYTES) {
      warnTitleOverflow(state);
      state.titleBytes = [];
      state.phase = 'screen-title-ignore';
      return;
    }
    const byte = src[i];
    if (byte === undefined) {
      return;
    }
    state.titleBytes.push(byte);
  }
}

export function takeDcsBytes(state: ParserState): Uint8Array {
  if (state.dcsBytes.length === 0) {
    return EMPTY_UINT8;
  }
  return Uint8Array.from(state.dcsBytes);
}
