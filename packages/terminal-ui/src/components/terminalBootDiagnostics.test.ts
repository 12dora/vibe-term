import { describe, expect, test } from 'bun:test';
import type { TerminalSurfaceDiagnosticState } from './TerminalSurface';
import { terminalStreamDiagnostic } from './terminalBootDiagnostics';

describe('terminalStreamDiagnostic', () => {
  test('reports an initializing surface before the render face exists', () => {
    expect(terminalStreamDiagnostic('relay', undefined)).toEqual({
      sourceRoute: 'relay',
      paneEpoch: null,
      terminalSeq: null,
      historyEpoch: null,
      historyBeforeLine: null,
      recoveryState: 'initializing',
      recoveryReason: null,
      replayBytes: 0,
      replayBytesLimit: 0,
      historyBytes: 0,
      historyBytesLimit: 0,
      historyPages: 0,
      historyPagesLimit: 0,
    });
  });

  test('flattens the surface state and keeps replay counters at zero', () => {
    const state: TerminalSurfaceDiagnosticState = {
      paneEpoch: new Uint8Array([7]),
      historyEpoch: new Uint8Array([8]),
      historyBeforeLine: 42,
      recoveryState: 'recovering',
      recoveryReason: 'cache_evicted',
      historyBytes: 1024,
      historyBytesLimit: 8192,
      historyPages: 2,
      historyPagesLimit: 64,
    };

    expect(terminalStreamDiagnostic('gateway', state)).toEqual({
      sourceRoute: 'gateway',
      paneEpoch: state.paneEpoch,
      terminalSeq: null,
      historyEpoch: state.historyEpoch,
      historyBeforeLine: 42,
      recoveryState: 'recovering',
      recoveryReason: 'cache_evicted',
      replayBytes: 0,
      replayBytesLimit: 0,
      historyBytes: 1024,
      historyBytesLimit: 8192,
      historyPages: 2,
      historyPagesLimit: 64,
    });
  });
});
