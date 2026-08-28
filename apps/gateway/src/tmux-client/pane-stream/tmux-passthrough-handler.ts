import type { ParserContext } from './parser-state';
import {
  TMUX_PASSTHROUGH_PREFIX_BYTES,
  appendDcsByte,
  resetDcsState,
  takeDcsBytes,
  writeByte,
  writeBytes,
  writeRun,
} from './parser-state';

export function refillIncompleteCsi(ctx: ParserContext): void {
  const { state } = ctx;
  if (state.phase !== 'csi') {
    return;
  }
  writeByte(ctx.output, 0x1b);
  writeByte(ctx.output, 0x5b);
  writeBytes(ctx.output, state.csiBytes);
  state.csiBytes = [];
  state.phase = 'normal';
}

export function flushTmuxPassthrough(ctx: ParserContext): void {
  const content = takeDcsBytes(ctx.state);
  resetDcsState(ctx.state);
  ctx.state.phase = 'normal';
  ctx.pendingPassthrough.push(content);
}

export function handleDcsDetect(ctx: ParserContext, byte: number): void {
  const { state } = ctx;
  const expected = TMUX_PASSTHROUGH_PREFIX_BYTES[state.dcsPrefixLength];
  if (byte === expected) {
    state.dcsPrefixLength += 1;
    if (state.dcsPrefixLength === TMUX_PASSTHROUGH_PREFIX_BYTES.length) {
      state.dcsBytes = [];
      state.phase = 'dcs-tmux';
    }
    return;
  }
  writeByte(ctx.output, 0x1b);
  writeByte(ctx.output, 0x50);
  if (state.dcsPrefixLength > 0) {
    writeRun(ctx.output, TMUX_PASSTHROUGH_PREFIX_BYTES, 0, state.dcsPrefixLength);
  }
  state.dcsPrefixLength = 0;
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
