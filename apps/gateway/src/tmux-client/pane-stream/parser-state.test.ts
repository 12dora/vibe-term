import { describe, expect, test } from 'bun:test';

import type { PaneStreamParserOptions } from '../pane-stream-parser';
import type { ParserContext } from './parser-state';
import {
  MAX_DCS_PASSTHROUGH_BYTES,
  MAX_OSC_PAYLOAD_BYTES,
  appendDcsByte,
  appendOscPayloadByte,
  createParserOutput,
  createParserState,
} from './parser-state';

const options: PaneStreamParserOptions = {
  onTitle: () => {},
  onBell: () => {},
  onNotification: () => {},
};

function makeCtx(): ParserContext {
  return {
    state: createParserState(),
    options,
    output: createParserOutput(0),
    processByte: () => {},
    pendingPassthrough: [],
  };
}

describe('parser overflow helpers', () => {
  test('appendOscPayloadByte ignores further bytes after 8KB', () => {
    const ctx = makeCtx();
    ctx.state.phase = 'osc-body';
    let accepted = 0;
    for (let i = 0; i < MAX_OSC_PAYLOAD_BYTES; i += 1) {
      if (appendOscPayloadByte(ctx, 0x41)) {
        accepted += 1;
      }
    }
    expect(accepted).toBe(MAX_OSC_PAYLOAD_BYTES);
    expect(appendOscPayloadByte(ctx, 0x42)).toBe(false);
    expect(String(ctx.state.phase)).toBe('osc-body-ignore');
    expect(ctx.state.oscPayloadBytes).toEqual([]);
    expect(ctx.state.warnedOscPayloadOverflow).toBe(true);
  });

  test('appendDcsByte ignores further bytes after 64KB', () => {
    const ctx = makeCtx();
    ctx.state.phase = 'dcs-tmux';
    let accepted = 0;
    for (let i = 0; i < MAX_DCS_PASSTHROUGH_BYTES; i += 1) {
      if (appendDcsByte(ctx, 0x41)) {
        accepted += 1;
      }
    }
    expect(accepted).toBe(MAX_DCS_PASSTHROUGH_BYTES);
    expect(appendDcsByte(ctx, 0x42)).toBe(false);
    expect(String(ctx.state.phase)).toBe('dcs-tmux-ignore');
    expect(ctx.state.dcsBytes).toEqual([]);
    expect(ctx.state.warnedDcsOverflow).toBe(true);
  });
});
