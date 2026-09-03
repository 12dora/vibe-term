import type { ParserContext } from './parser-state';
import { MAX_CSI_BYTES, THEME_UPDATES_MODE, writeByte, writeBytes } from './parser-state';

const THEME_UPDATES_MODE_BYTES = new TextEncoder().encode(THEME_UPDATES_MODE);

function isThemeUpdatesMode(csiBytes: Uint8Array, start: number, end: number): boolean {
  if (end - start !== THEME_UPDATES_MODE_BYTES.length) return false;
  for (let index = 0; index < THEME_UPDATES_MODE_BYTES.length; index += 1) {
    if (csiBytes[start + index] !== THEME_UPDATES_MODE_BYTES[index]) return false;
  }
  return true;
}

function includesThemeUpdatesMode(csiBytes: Uint8Array, csiLength: number): boolean {
  let start = 1;
  for (let index = 1; index <= csiLength; index += 1) {
    if (index !== csiLength && csiBytes[index] !== 0x3b) continue;
    if (isThemeUpdatesMode(csiBytes, start, index)) return true;
    start = index + 1;
  }
  return false;
}

export function maybeEmitThemeSubscription(
  csiBytes: Uint8Array,
  csiLength: number,
  finalByte: number,
  inTmuxPassthrough: boolean,
  onThemeSubscription?: (subscribed: boolean) => void
): void {
  if (finalByte !== 0x68 && finalByte !== 0x6c) return;
  if (csiLength === 0 || csiBytes[0] !== 0x3f || inTmuxPassthrough) return;
  if (includesThemeUpdatesMode(csiBytes, csiLength)) onThemeSubscription?.(finalByte === 0x68);
}

function writeCsiPrefix(ctx: ParserContext): void {
  writeByte(ctx.output, 0x1b);
  writeByte(ctx.output, 0x5b);
  writeBytes(ctx.output, ctx.state.csiBytes, ctx.state.csiLength);
}

export function handleCsi(ctx: ParserContext, byte: number): void {
  const { state } = ctx;
  if (byte >= 0x40 && byte <= 0x7e) {
    writeCsiPrefix(ctx);
    writeByte(ctx.output, byte);
    maybeEmitThemeSubscription(
      state.csiBytes,
      state.csiLength,
      byte,
      state.inTmuxPassthrough,
      ctx.options.onThemeSubscription
    );
    state.csiLength = 0;
    state.phase = 'normal';
    return;
  }
  if (byte >= 0x20 && byte <= 0x3f && state.csiLength < MAX_CSI_BYTES) {
    state.csiBytes[state.csiLength] = byte;
    state.csiLength += 1;
    return;
  }
  writeCsiPrefix(ctx);
  state.csiLength = 0;
  state.phase = 'normal';
  ctx.processByte(byte);
}
