import type { ParserContext } from './parser-state';
import { TMUX_PASSTHROUGH_PREFIX, appendDcsByte, resetDcsState } from './parser-state';

export function flushTmuxPassthrough(ctx: ParserContext): void {
  const { state } = ctx;
  const content = state.dcsBytes;
  resetDcsState(state);
  state.phase = 'normal';
  state.inTmuxPassthrough = true;
  try {
    for (const byte of content) {
      ctx.processByte(byte);
    }
  } finally {
    state.inTmuxPassthrough = false;
  }
  if (String(state.phase) === 'csi') {
    // 解包内容以不完整 CSI 结尾：回填并复位，避免后续普通流被误并入
    ctx.output.push(0x1b, 0x5b, ...state.csiBytes);
    state.csiBytes = [];
    state.phase = 'normal';
  }
}

export function handleDcsDetect(ctx: ParserContext, byte: number): void {
  const { state, output } = ctx;
  const expected = TMUX_PASSTHROUGH_PREFIX.charCodeAt(state.dcsPrefix.length);
  if (byte === expected) {
    state.dcsPrefix += String.fromCharCode(byte);
    if (state.dcsPrefix.length === TMUX_PASSTHROUGH_PREFIX.length) {
      state.dcsBytes = [];
      state.phase = 'dcs-tmux';
    }
    return;
  }
  output.push(0x1b, 0x50);
  for (const prefixChar of state.dcsPrefix) {
    output.push(prefixChar.charCodeAt(0));
  }
  state.dcsPrefix = '';
  state.phase = 'normal';
  ctx.processByte(byte);
}

function handleDcsTmux(ctx: ParserContext, byte: number): void {
  if (byte === 0x1b) {
    ctx.state.phase = 'dcs-tmux-esc';
    return;
  }
  appendDcsByte(ctx, byte);
}

function handleDcsTmuxEsc(ctx: ParserContext, byte: number): void {
  if (byte === 0x5c) {
    flushTmuxPassthrough(ctx);
    return;
  }
  if (byte === 0x1b) {
    ctx.state.phase = 'dcs-tmux';
    appendDcsByte(ctx, 0x1b);
    return;
  }
  ctx.state.phase = 'dcs-tmux';
  if (appendDcsByte(ctx, 0x1b)) {
    appendDcsByte(ctx, byte);
  }
}

function handleDcsTmuxIgnore(ctx: ParserContext, byte: number): void {
  if (byte === 0x1b) {
    ctx.state.phase = 'dcs-tmux-ignore-esc';
  }
}

function handleDcsTmuxIgnoreEsc(ctx: ParserContext, byte: number): void {
  if (byte === 0x5c) {
    resetDcsState(ctx.state);
    ctx.state.phase = 'normal';
    return;
  }
  if (byte !== 0x1b) {
    ctx.state.phase = 'dcs-tmux-ignore';
  }
}

export function handleTmuxPassthrough(ctx: ParserContext, byte: number): void {
  switch (ctx.state.phase) {
    case 'dcs-tmux':
      handleDcsTmux(ctx, byte);
      return;
    case 'dcs-tmux-esc':
      handleDcsTmuxEsc(ctx, byte);
      return;
    case 'dcs-tmux-ignore':
      handleDcsTmuxIgnore(ctx, byte);
      return;
    case 'dcs-tmux-ignore-esc':
      handleDcsTmuxIgnoreEsc(ctx, byte);
      return;
    default:
      return;
  }
}
