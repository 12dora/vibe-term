import type { ParserContext } from './parser-state';

export function handleNormal(ctx: ParserContext, byte: number): void {
  if (byte === 0x1b) {
    ctx.state.phase = 'esc';
    return;
  }
  if (byte === 0x07) {
    ctx.options.onBell();
    return;
  }
  ctx.output.push(byte);
}
