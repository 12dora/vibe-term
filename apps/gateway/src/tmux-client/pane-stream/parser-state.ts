import type { PaneStreamParserOptions } from '../pane-stream-parser';

export const MAX_OSC_KIND_BYTES = 16;
export const MAX_OSC_PAYLOAD_BYTES = 8 * 1024;
export const MAX_TITLE_BYTES = 8 * 1024;
export const MAX_DCS_PASSTHROUGH_BYTES = 64 * 1024;
export const MAX_KITTY_PENDING_IDS = 16;
export const MAX_CSI_BYTES = 64;
export const TMUX_PASSTHROUGH_PREFIX = 'tmux;';
export const THEME_UPDATES_MODE = '2031';

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

export type ParserState = {
  phase: ParserPhase;
  oscKind: string;
  oscPayloadBytes: number[];
  titleBytes: number[];
  dcsPrefix: string;
  dcsBytes: number[];
  csiBytes: number[];
  inTmuxPassthrough: boolean;
  warnedOscPayloadOverflow: boolean;
  warnedTitleOverflow: boolean;
  warnedDcsOverflow: boolean;
  kittyPending: Map<string, KittyPending>;
};

export type ParserContext = {
  state: ParserState;
  options: PaneStreamParserOptions;
  output: number[];
  processByte: (byte: number) => void;
};

export function createParserState(): ParserState {
  return {
    phase: 'normal',
    oscKind: '',
    oscPayloadBytes: [],
    titleBytes: [],
    dcsPrefix: '',
    dcsBytes: [],
    csiBytes: [],
    inTmuxPassthrough: false,
    warnedOscPayloadOverflow: false,
    warnedTitleOverflow: false,
    warnedDcsOverflow: false,
    kittyPending: new Map(),
  };
}

export function resetOscState(state: ParserState): void {
  state.oscKind = '';
  state.oscPayloadBytes = [];
}

export function resetDcsState(state: ParserState): void {
  state.dcsBytes = [];
  state.dcsPrefix = '';
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

export function warnTitleOverflow(state: ParserState): void {
  if (!state.warnedTitleOverflow) {
    state.warnedTitleOverflow = true;
    console.warn('[tmex] pane stream parser dropped oversized title');
  }
}
