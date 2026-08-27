import type { ParserContext } from './parser-state';
import {
  MAX_CSI_BYTES,
  THEME_UPDATES_MODE,
  utf8Decoder,
  writeByte,
  writeBytes,
} from './parser-state';

export function maybeEmitThemeSubscription(
  csiBytes: number[],
  finalByte: number,
  inTmuxPassthrough: boolean,
  onThemeSubscription?: (subscribed: boolean) => void
): void {
  if ((finalByte === 0x68 || finalByte === 0x6c) && csiBytes[0] === 0x3f && !inTmuxPassthrough) {
    const params = utf8Decoder.decode(new Uint8Array(csiBytes.slice(1))).split(';');
    if (params.includes(THEME_UPDATES_MODE)) {
      onThemeSubscription?.(finalByte === 0x68);
    }
  }
}

function writeCsiPrefix(ctx: ParserContext): void {
  writeByte(ctx.output, 0x1b);
  writeByte(ctx.output, 0x5b);
  writeBytes(ctx.output, ctx.state.csiBytes);
}

export function handleCsi(ctx: ParserContext, byte: number): void {
  const { state } = ctx;
  if (byte >= 0x40 && byte <= 0x7e) {
    writeCsiPrefix(ctx);
    writeByte(ctx.output, byte);
    maybeEmitThemeSubscription(
      state.csiBytes,
      byte,
      state.inTmuxPassthrough,
      ctx.options.onThemeSubscription
    );
    state.csiBytes = [];
    state.phase = 'normal';
    return;
  }
  if (byte >= 0x20 && byte <= 0x3f && state.csiBytes.length < MAX_CSI_BYTES) {
    state.csiBytes.push(byte);
    return;
  }
  writeCsiPrefix(ctx);
  state.csiBytes = [];
  state.phase = 'normal';
  ctx.processByte(byte);
}
