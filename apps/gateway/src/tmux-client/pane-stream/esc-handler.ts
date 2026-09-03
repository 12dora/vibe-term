import type { ParserContext } from './parser-state';
import { resetOscState, writeByte } from './parser-state';

export function handleEsc(ctx: ParserContext, byte: number): void {
  const { state } = ctx;
  if (byte === 0x5d) {
    resetOscState(state);
    state.phase = 'osc-params';
    return;
  }
  if (byte === 0x6b) {
    state.titleBytes = [];
    state.phase = 'screen-title';
    return;
  }
  if (byte === 0x50) {
    state.dcsPrefixLength = 0;
    state.phase = 'dcs-detect';
    return;
  }
  if (byte === 0x5b) {
    state.csiLength = 0;
    state.phase = 'csi';
    return;
  }
  writeByte(ctx.output, 0x1b);
  writeByte(ctx.output, byte);
  state.phase = 'normal';
}
