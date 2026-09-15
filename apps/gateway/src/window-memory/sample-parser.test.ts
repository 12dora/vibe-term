import { describe, expect, test } from 'bun:test';

import { SamplerParseError, parseSamplerOutput } from './sample-parser';

describe('parseSamplerOutput', () => {
  test('parses a supported header and pane rows', () => {
    const stdout = [
      'VTMEM 1 1000 1',
      '%1\t4242\ttmux-spawn-abc.scope\t1048576\t8589934592\t12884901888\t4294967296\t0\t1',
      '%2\t99\t-\t0\t0\t0\t0\t0\t0',
    ].join('\n');
    expect(parseSamplerOutput(stdout)).toEqual({
      supported: true,
      uid: 1000,
      panes: [
        {
          paneId: '%1',
          pid: 4242,
          scope: 'tmux-spawn-abc.scope',
          current: 1_048_576,
          high: 8_589_934_592,
          max: 12_884_901_888,
          swapMax: 4_294_967_296,
          oomKills: 0,
          managed: true,
        },
        {
          paneId: '%2',
          pid: 99,
          scope: null,
          current: 0,
          high: 0,
          max: 0,
          swapMax: 0,
          oomKills: 0,
          managed: false,
        },
      ],
    });
  });

  test('parses unsupported header-only output', () => {
    expect(parseSamplerOutput('VTMEM 1 501 0\n')).toEqual({
      supported: false,
      uid: 501,
      panes: [],
    });
  });

  test('rejects garbage output', () => {
    expect(() => parseSamplerOutput('')).toThrow(SamplerParseError);
    expect(() => parseSamplerOutput('hello')).toThrow(SamplerParseError);
    expect(() => parseSamplerOutput('VTMEM 2 1 1')).toThrow(SamplerParseError);
    expect(() => parseSamplerOutput('VTMEM 1 1 0\n%1\t1\t-\t0\t0\t0\t0\t0\t0')).toThrow(
      SamplerParseError
    );
    expect(() => parseSamplerOutput('VTMEM 1 1 1\nnot-a-row')).toThrow(SamplerParseError);
    expect(() => parseSamplerOutput('VTMEM 1 1 1\n%1\t1\tnot-a-scope\t0\t0\t0\t0\t0\t0')).toThrow(
      SamplerParseError
    );
  });
});
