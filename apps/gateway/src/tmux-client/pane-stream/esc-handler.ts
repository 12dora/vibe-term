import type { ParserContext } from './parser-state';
import { resetOscState } from './parser-state';

export function handleEsc(ctx: ParserContext, byte: number): void {
  const { state, output } = ctx;
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
    state.dcsPrefix = '';
    state.phase = 'dcs-detect';
    return;
  }
  if (byte === 0x5b) {
    state.csiBytes = [];
    state.phase = 'csi';
    return;
  }
  output.push(0x1b, byte);
  state.phase = 'normal';
}
