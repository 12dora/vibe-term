import { afterEach, describe, expect, test } from 'bun:test';
import { logAt } from '../log/level';
import { formatTmuxMetricsLine } from './tmux-metrics-line';

const sample = {
  intervalMs: 30_000,
  rawChunks: 12,
  rawBytes: 4096,
  controlOutputs: 3,
  controlOutputBytes: 200,
  terminalOutputs: 9,
  terminalOutputBytes: 1024,
  titles: 1,
  bells: 0,
  notifications: 0,
  structureChanges: 0,
  blocks: 0,
};

describe('tmux-metrics log-level gate', () => {
  const prev = process.env.TMEX_LOG_LEVEL;
  afterEach(() => {
    if (prev === undefined) delete process.env.TMEX_LOG_LEVEL;
    else process.env.TMEX_LOG_LEVEL = prev;
  });

  test('format includes raw_bytes vs terminal_output_bytes ratio fields', () => {
    const line = formatTmuxMetricsLine(sample);
    expect(line.startsWith('[tmux-metrics] control_stream ')).toBe(true);
    expect(line).toContain('raw_bytes=4096');
    expect(line).toContain('terminal_output_bytes=1024');
    expect(line).toContain('interval_ms=30000');
  });

  test('emits at TMEX_LOG_LEVEL=debug and stays silent at info', () => {
    const logged: string[] = [];
    const spy = (...args: unknown[]) => {
      logged.push(String(args[0]));
    };
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = spy as typeof console.log;
    console.warn = spy as typeof console.warn;
    console.error = spy as typeof console.error;
    try {
      process.env.TMEX_LOG_LEVEL = 'info';
      logAt('debug', formatTmuxMetricsLine(sample));
      expect(logged).toEqual([]);
      process.env.TMEX_LOG_LEVEL = 'debug';
      logAt('debug', formatTmuxMetricsLine(sample));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('[tmux-metrics]');
      expect(logged[0]).toContain('raw_bytes=4096');
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
  });
});
