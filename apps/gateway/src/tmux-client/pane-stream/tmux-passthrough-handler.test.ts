import { describe, expect, test } from 'bun:test';

import type { PaneStreamParserOptions } from '../pane-stream-parser';
import type { ParserContext } from './parser-state';
import { createParserOutput, createParserState, snapshotOutput } from './parser-state';
import { handleDcsDetect } from './tmux-passthrough-handler';

const options: PaneStreamParserOptions = {
  onTitle: () => {},
  onBell: () => {},
  onNotification: () => {},
};

function detectContext() {
  const reprocessed: number[] = [];
  const state = createParserState();
  state.phase = 'dcs-detect';
  const ctx: ParserContext = {
    state,
    options,
    output: createParserOutput(16),
    processByte: (byte) => {
      reprocessed.push(byte);
    },
    pendingPassthrough: [],
  };
  return { ctx, state, reprocessed };
}

describe('handleDcsDetect', () => {
  test('tmux; prefix enters passthrough collection', () => {
    const { ctx, state } = detectContext();
    for (const char of 'tmux;') {
      handleDcsDetect(ctx, char.charCodeAt(0));
    }
    expect(state.phase).toBe('dcs-tmux');
    expect(state.dcsBytes).toEqual([]);
    expect(snapshotOutput(ctx.output)).toEqual([]);
  });

  test('mismatch emits ESC P plus prefix and reprocesses the byte', () => {
    const { ctx, state, reprocessed } = detectContext();
    handleDcsDetect(ctx, 0x74);
    handleDcsDetect(ctx, 0x58);
    expect(snapshotOutput(ctx.output)).toEqual([0x1b, 0x50, 0x74]);
    expect(reprocessed).toEqual([0x58]);
    expect(state.phase).toBe('normal');
    expect(state.dcsPrefixLength).toBe(0);
  });
});
