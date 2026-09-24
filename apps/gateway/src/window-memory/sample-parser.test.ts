import { describe, expect, test } from 'bun:test';

import { SamplerParseError, parseSamplerOutput } from './sample-parser';

describe('parseSamplerOutput', () => {
  test('parses a limits-supported header and pane rows', () => {
    const stdout = [
      'VTMEM 2 1000 1 ok',
      '%1\t4242\ttmux-spawn-abc.scope\t1048576\t8589934592\t12884901888\t4294967296\t0\t1\tcgroup',
      '%2\t99\t-\t4096\t0\t0\t0\t0\t0\trss',
    ].join('\n');
    expect(parseSamplerOutput(stdout)).toEqual({
      limitsSupported: true,
      uid: 1000,
      reason: 'ok',
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
          source: 'cgroup',
        },
        {
          paneId: '%2',
          pid: 99,
          scope: null,
          current: 4096,
          high: 0,
          max: 0,
          swapMax: 0,
          oomKills: 0,
          managed: false,
          source: 'rss',
        },
      ],
    });
  });

  test('parses limits-supported header with ok reason and no panes', () => {
    expect(parseSamplerOutput('VTMEM 2 1000 1 ok\n')).toEqual({
      limitsSupported: true,
      uid: 1000,
      reason: 'ok',
      panes: [],
    });
  });

  test('allows pane rows when limitsSupported is 0', () => {
    const stdout = [
      'VTMEM 2 501 0 no-cgroup2',
      '%1\t99\t-\t4096\t0\t0\t0\t0\t0\trss',
      '%2\t100\t-\t0\t0\t0\t0\t0\t0\tnone',
    ].join('\n');
    expect(parseSamplerOutput(stdout)).toEqual({
      limitsSupported: false,
      uid: 501,
      reason: 'no-cgroup2',
      panes: [
        {
          paneId: '%1',
          pid: 99,
          scope: null,
          current: 4096,
          high: 0,
          max: 0,
          swapMax: 0,
          oomKills: 0,
          managed: false,
          source: 'rss',
        },
        {
          paneId: '%2',
          pid: 100,
          scope: null,
          current: 0,
          high: 0,
          max: 0,
          swapMax: 0,
          oomKills: 0,
          managed: false,
          source: 'none',
        },
      ],
    });
  });

  test('parses no-cgroup2 and no-user-systemd reasons', () => {
    expect(parseSamplerOutput('VTMEM 2 1000 0 no-cgroup2\n')).toEqual({
      limitsSupported: false,
      uid: 1000,
      reason: 'no-cgroup2',
      panes: [],
    });
    expect(parseSamplerOutput('VTMEM 2 1000 0 no-user-systemd\n')).toEqual({
      limitsSupported: false,
      uid: 1000,
      reason: 'no-user-systemd',
      panes: [],
    });
  });

  test('unreadable swap is ?, not a numeric zero', () => {
    const parsed = parseSamplerOutput(
      'VTMEM 2 1000 1 ok\n%1\t4242\ttmux-spawn-abc.scope\t1048576\t8589934592\t12884901888\t?\t0\t1\tcgroup'
    );
    expect(parsed.panes[0]).toEqual(
      expect.objectContaining({ swapMax: 0, swapUnknown: true, source: 'cgroup' })
    );
  });

  test('rejects garbage output', () => {
    expect(() => parseSamplerOutput('')).toThrow(SamplerParseError);
    expect(() => parseSamplerOutput('hello')).toThrow(SamplerParseError);
    expect(() => parseSamplerOutput('VTMEM 1 1 1 ok')).toThrow(SamplerParseError);
    expect(() => parseSamplerOutput('VTMEM 2 1 1')).toThrow(SamplerParseError);
    expect(() => parseSamplerOutput('VTMEM 2 1 1 ok\nnot-a-row')).toThrow(SamplerParseError);
    expect(() =>
      parseSamplerOutput('VTMEM 2 1 1 ok\n%1\t1\tnot-a-scope\t0\t0\t0\t0\t0\t0\tcgroup')
    ).toThrow(SamplerParseError);
    expect(() => parseSamplerOutput('VTMEM 2 1 0 mystery')).toThrow(SamplerParseError);
    expect(() => parseSamplerOutput('VTMEM 2 1 1 ok\n%1\t1\t-\t0\t0\t0\t0\t0\t0')).toThrow(
      SamplerParseError
    );
    expect(() => parseSamplerOutput('VTMEM 2 1 1 ok\n%1\t1\t-\t0\t0\t0\t0\t0\t0\txyz')).toThrow(
      SamplerParseError
    );
  });

  test('rejects invalid source values', () => {
    expect(() => parseSamplerOutput('VTMEM 2 1 1 ok\n%1\t1\t-\t0\t0\t0\t0\t0\t0\tpss')).toThrow(
      SamplerParseError
    );
  });
});
