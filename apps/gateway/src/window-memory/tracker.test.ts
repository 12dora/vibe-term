import { describe, expect, spyOn, test } from 'bun:test';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS, type WindowMemorySettings } from '@vibeterm/shared';

import { MIB_BYTES } from './constants';
import { isOrphanSweepScript } from './orphan-scopes';
import { createWindowMemoryTracker } from './tracker';
import type { MemoryPaneRef as PaneRef } from './tracker-ops';
import type {
  HostShellResult,
  HostShellRunner,
  WindowMemoryAggregate,
  WindowMemoryConnectionHooks,
  WindowOomKillEvent,
} from './types';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeClock {
  time = 0;
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  schedule = {
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = ++this.nextId;
      this.timers.set(id, { at: this.time + delayMs, callback });
      return id;
    },
    clearTimeout: (timer: unknown) => {
      this.timers.delete(timer as number);
    },
  };
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = target;
  }
}

function sampleLine(opts: {
  paneId?: string;
  pid?: number;
  scope?: string;
  current?: number;
  high?: number;
  max?: number;
  swapMax?: number;
  oomKill?: number;
  managed?: 0 | 1;
  source?: 'cgroup' | 'rss' | 'none';
}): string {
  return [
    opts.paneId ?? '%1',
    String(opts.pid ?? 4242),
    opts.scope ?? (opts.source === 'rss' || opts.source === 'none' ? '-' : 'tmux-spawn-abc.scope'),
    String(opts.current ?? 0),
    String(opts.high ?? 0),
    String(opts.max ?? 0),
    String(opts.swapMax ?? 0),
    String(opts.oomKill ?? 0),
    String(opts.managed ?? 0),
    opts.source ?? 'cgroup',
  ].join('\t');
}

function supportedOutput(lines: string[], uid = 1000): string {
  return [`VTMEM 2 ${uid} 1 ok`, ...lines].join('\n');
}

function headerOutput(
  limitsSupported: 0 | 1,
  reason: 'ok' | 'no-cgroup2' | 'no-user-systemd',
  lines: string[] = [],
  uid = 1000
): string {
  return [`VTMEM 2 ${uid} ${limitsSupported} ${reason}`, ...lines].join('\n');
}

function setup(opts?: {
  settings?: Partial<WindowMemorySettings>;
  panes?: PaneRef[];
  run?: (script: string) => HostShellResult | Promise<HostShellResult>;
  stdout?: string | ((script: string) => string);
  exitCode?: number;
  initialMarks?: Array<[string, string]>;
  sweepStdout?: string;
}) {
  const clock = new FakeClock();
  let settings: WindowMemorySettings = { ...WINDOW_MEMORY_SETTINGS_DEFAULTS, ...opts?.settings };
  let panes: PaneRef[] = opts?.panes ?? [
    { paneId: '%1', windowId: '@1', windowName: 'main', pid: 4242 },
  ];
  const scripts: string[] = [];
  const samples: WindowMemoryAggregate[][] = [];
  const oomEvents: WindowOomKillEvent[] = [];
  const support: boolean[] = [];
  const marks = new Map<string, { scope: string; oomKills: number }>();
  for (const [deviceId, windowId] of opts?.initialMarks ?? []) {
    marks.set(`${deviceId}/${windowId}`, { scope: 'tmux-spawn-abc.scope', oomKills: 1 });
  }
  const host: HostShellRunner = {
    runHostShell: async (script): Promise<HostShellResult> => {
      scripts.push(script);
      if (isOrphanSweepScript(script)) {
        return {
          stdout: opts?.sweepStdout ?? 'VTORPHAN 0 no-server\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (opts?.run) return opts.run(script);
      const stdout =
        typeof opts?.stdout === 'function'
          ? opts.stdout(script)
          : (opts?.stdout ?? supportedOutput([sampleLine({})]));
      return { stdout, stderr: '', exitCode: opts?.exitCode ?? 0 };
    },
  };
  const hooks: WindowMemoryConnectionHooks = {
    getSettings: () => settings,
    oomMarks: {
      has: (deviceId, windowId) => marks.has(`${deviceId}/${windowId}`),
      mark: (deviceId, windowId, scope, oomKills) => {
        marks.set(`${deviceId}/${windowId}`, { scope, oomKills });
      },
      clear: (deviceId, windowId) => {
        marks.delete(`${deviceId}/${windowId}`);
      },
      listWindowIds: (deviceId) =>
        [...marks.keys()]
          .filter((key) => key.startsWith(`${deviceId}/`))
          .map((key) => key.slice(deviceId.length + 1)),
      clearDevice: (deviceId) => {
        for (const key of [...marks.keys()]) {
          if (key.startsWith(`${deviceId}/`)) marks.delete(key);
        }
      },
    },
    onSample: (windows) => samples.push(windows),
    onOomKill: (event) => oomEvents.push(event),
    onSupport: (supported) => support.push(supported),
  };
  const tracker = createWindowMemoryTracker({
    deviceId: 'dev-1',
    host,
    hooks,
    getPanes: () => panes,
    now: clock.now,
    schedule: clock.schedule,
  });
  return {
    clock,
    tracker,
    scripts,
    samples,
    oomEvents,
    support,
    marks,
    setSettings: (next: Partial<WindowMemorySettings>) => {
      settings = { ...settings, ...next };
    },
    setPanes: (next: PaneRef[]) => {
      panes = next;
    },
  };
}

describe('WindowMemoryTracker', () => {
  test('no-cgroup2 with rss keeps sampling and sets limitsSupported=false', async () => {
    const { clock, tracker, scripts, support, samples } = setup({
      stdout: headerOutput(0, 'no-cgroup2', [sampleLine({ source: 'rss', current: 4096 })]),
    });
    tracker.start();
    await flush();
    expect(support).toEqual([true]);
    expect(tracker.supported).toBe(true);
    expect(tracker.limitsSupported).toBe(false);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).not.toContain('set-property');
    expect(samples).toHaveLength(1);
    expect(samples[0]?.[0]).toEqual(
      expect.objectContaining({ source: 'rss', current: 4096, windowId: '@1' })
    );
    await clock.advance(5_000);
    expect(scripts).toHaveLength(2);
    expect(tracker.limitsSupported).toBe(false);
    expect(tracker.supported).toBe(true);
  });

  test('transient no-user-systemd keeps sampling and recovers limitsSupported', async () => {
    const rssLine = sampleLine({ source: 'rss', current: 2048 });
    let stdout = headerOutput(0, 'no-user-systemd', [rssLine]);
    const { tracker, scripts, support } = setup({ stdout: () => stdout });
    await tracker.tick();
    await tracker.tick();
    expect(tracker.supported).toBe(true);
    expect(tracker.limitsSupported).toBeNull();
    expect(support).toEqual([true]);
    expect(scripts).toHaveLength(2);
    stdout = supportedOutput([sampleLine({ managed: 0 })]);
    await tracker.tick();
    expect(tracker.supported).toBe(true);
    expect(tracker.limitsSupported).toBe(true);
    expect(support).toEqual([true]);
  });

  test('pins limitsSupported=false after 6 consecutive no-user-systemd then recovers', async () => {
    const rssLine = sampleLine({ source: 'rss', current: 2048 });
    let stdout = headerOutput(0, 'no-user-systemd', [rssLine]);
    const { clock, tracker, scripts, support } = setup({ stdout: () => stdout });
    tracker.start();
    await flush();
    for (let i = 0; i < 5; i++) await clock.advance(5_000);
    expect(tracker.supported).toBe(true);
    expect(tracker.limitsSupported).toBe(false);
    expect(support).toEqual([true]);
    expect(scripts).toHaveLength(6);
    await clock.advance(5_000);
    expect(scripts).toHaveLength(7);
    stdout = supportedOutput([sampleLine({ managed: 0 })]);
    await clock.advance(5_000);
    expect(tracker.supported).toBe(true);
    expect(tracker.limitsSupported).toBe(true);
    expect(support).toEqual([true]);
  });

  test('mixed window: one pane in a scope keeps limitsSupported=true', async () => {
    const { tracker } = setup({
      panes: [
        { paneId: '%1', windowId: '@1', windowName: 'main', pid: 4242 },
        { paneId: '%2', windowId: '@1', windowName: 'main', pid: 4343 },
      ],
      stdout: supportedOutput([
        sampleLine({ paneId: '%1', current: 1000 }),
        sampleLine({ paneId: '%2', pid: 4343, source: 'rss', current: 2000 }),
      ]),
    });
    await tracker.tick();
    expect(tracker.limitsSupported).toBe(true);
    expect(tracker.getWindows()).toEqual([
      expect.objectContaining({ source: 'rss', current: 3000 }),
    ]);
  });

  test('limitsSupported recovers once panes land in scopes again', async () => {
    let stdout = supportedOutput([sampleLine({ source: 'rss', current: 2048 })]);
    const { clock, tracker } = setup({ stdout: () => stdout });
    tracker.start();
    await flush();
    expect(tracker.limitsSupported).toBe(false);
    stdout = supportedOutput([sampleLine({ current: 4096 })]);
    await clock.advance(5_000);
    expect(tracker.limitsSupported).toBe(true);
  });

  test('old tmux: header 1 ok + rss emits source=rss and limitsSupported=false', async () => {
    const { tracker, samples } = setup({
      stdout: supportedOutput([sampleLine({ source: 'rss', current: 12_345 })]),
    });
    await tracker.tick();
    expect(tracker.supported).toBe(true);
    // cgroup v2 与用户 systemd 都在，但一个 pane scope 都没有：限额没有着落点。
    expect(tracker.limitsSupported).toBe(false);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.[0]).toEqual(
      expect.objectContaining({ source: 'rss', current: 12_345, windowId: '@1' })
    );
    expect(tracker.getWindows()).toEqual([
      expect.objectContaining({ source: 'rss', current: 12_345 }),
    ]);
  });

  test('all-none 6 ticks sets supported=false but keeps sampling at 60s backoff', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    let stdout = supportedOutput([sampleLine({ source: 'none', current: 0 })]);
    const { clock, tracker, scripts, support, samples } = setup({
      stdout: () => stdout,
    });
    tracker.start();
    await flush();
    expect(tracker.supported).toBeNull();
    expect(tracker.limitsSupported).toBe(true);
    expect(support).toEqual([]);
    expect(samples).toEqual([]);
    expect(tracker.getWindows()).toEqual([]);
    for (let i = 0; i < 5; i++) await clock.advance(5_000);
    expect(tracker.supported).toBe(false);
    expect(support).toEqual([false]);
    expect(scripts).toHaveLength(6);
    expect(
      info.mock.calls.some((args) => String(args[0]).includes('unsupported device=dev-1'))
    ).toBe(true);
    expect(clock.timers.size).toBe(1);
    await clock.advance(5_000);
    expect(scripts).toHaveLength(6);
    await clock.advance(55_000);
    expect(scripts).toHaveLength(7);
    expect(tracker.supported).toBe(false);

    stdout = supportedOutput([sampleLine({ source: 'rss', current: 4096 })]);
    await clock.advance(60_000);
    expect(tracker.supported).toBe(true);
    expect(support).toEqual([false, true]);
    expect(scripts).toHaveLength(8);
    expect(samples.at(-1)?.[0]).toEqual(
      expect.objectContaining({ source: 'rss', current: 4096, windowId: '@1' })
    );
    await clock.advance(5_000);
    expect(scripts).toHaveLength(9);
    info.mockRestore();
  });

  test('window dropped as none is removed from lastSent and re-emits on recovery', async () => {
    let sources: Record<string, 'rss' | 'none'> = { '%1': 'rss', '%2': 'rss' };
    const { tracker, samples } = setup({
      panes: [
        { paneId: '%1', windowId: '@1', windowName: 'one', pid: 11 },
        { paneId: '%2', windowId: '@2', windowName: 'two', pid: 22 },
      ],
      stdout: () =>
        supportedOutput([
          sampleLine({
            paneId: '%1',
            pid: 11,
            source: sources['%1'],
            current: sources['%1'] === 'rss' ? 4096 : 0,
          }),
          sampleLine({
            paneId: '%2',
            pid: 22,
            source: sources['%2'],
            current: sources['%2'] === 'rss' ? 8192 : 0,
          }),
        ]),
    });
    await tracker.tick();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.map((window) => window.windowId).sort()).toEqual(['@1', '@2']);
    sources = { '%1': 'none', '%2': 'rss' };
    await tracker.tick();
    expect(tracker.getWindows().map((window) => window.windowId)).toEqual(['@2']);
    expect(samples).toHaveLength(1);
    sources = { '%1': 'rss', '%2': 'rss' };
    await tracker.tick();
    expect(samples).toHaveLength(2);
    expect(samples[1]).toEqual([
      expect.objectContaining({ windowId: '@1', source: 'rss', current: 4096 }),
    ]);
    expect(
      tracker
        .getWindows()
        .map((window) => window.windowId)
        .sort()
    ).toEqual(['@1', '@2']);
  });

  test('mixed cgroup+rss window aggregates as rss', async () => {
    const { tracker, samples } = setup({
      panes: [
        { paneId: '%1', windowId: '@1', windowName: 'main', pid: 11 },
        { paneId: '%2', windowId: '@1', windowName: 'main', pid: 22 },
      ],
      stdout: supportedOutput([
        sampleLine({ paneId: '%1', pid: 11, current: 1000, source: 'cgroup' }),
        sampleLine({ paneId: '%2', pid: 22, current: 2500, source: 'rss' }),
      ]),
    });
    await tracker.tick();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.[0]).toEqual(
      expect.objectContaining({ source: 'rss', current: 3500, panes: 2, windowId: '@1' })
    );
  });

  test('source change emits even when current is unchanged', async () => {
    let source: 'cgroup' | 'rss' = 'cgroup';
    const { tracker, samples } = setup({
      stdout: () =>
        supportedOutput([
          sampleLine({ current: MIB_BYTES, source, managed: source === 'cgroup' ? 1 : 0 }),
        ]),
    });
    await tracker.tick();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.[0]?.source).toBe('cgroup');
    source = 'rss';
    await tracker.tick();
    expect(samples).toHaveLength(2);
    expect(samples[1]?.[0]?.source).toBe('rss');
  });

  test('unmanaged scope gets set-property with configured values', async () => {
    const { tracker, scripts } = setup({
      stdout: supportedOutput([sampleLine({ managed: 0 })]),
    });
    await tracker.tick();
    const apply = scripts.find((script) => script.includes('set-property'));
    expect(apply).toContain('MemoryHigh=8192M');
    expect(apply).toContain('MemoryMax=12288M');
    expect(apply).toContain('MemorySwapMax=4096M');
    expect(apply).toContain('tmux-spawn-abc.scope');
    expect(apply?.indexOf('export XDG_RUNTIME_DIR=')).toBeGreaterThanOrEqual(0);
    expect(apply?.indexOf('DBUS_SESSION_BUS_ADDRESS') ?? -1).toBeLessThan(
      apply?.indexOf('systemctl') ?? 0
    );
    expect(scripts.some((script) => isOrphanSweepScript(script))).toBe(false);
  });

  test('zero high emits infinity so lowering to 0 re-applies', async () => {
    const { tracker, scripts, setSettings } = setup({
      stdout: supportedOutput([
        sampleLine({
          managed: 1,
          high: 8192 * MIB_BYTES,
          max: 12288 * MIB_BYTES,
          swapMax: 4096 * MIB_BYTES,
        }),
      ]),
    });
    await tracker.tick();
    expect(scripts.filter((s) => s.includes('set-property'))).toHaveLength(0);
    setSettings({ memoryHighMb: 0 });
    await tracker.tick();
    const apply = scripts.filter((s) => s.includes('set-property')).at(-1);
    expect(apply).toContain('MemoryHigh=infinity');
    expect(apply).toContain('MemoryMax=12288M');
    expect(apply).toContain('MemorySwapMax=4096M');
  });

  test('all-zero settings release managed scopes with infinity', async () => {
    let high = 8192 * MIB_BYTES;
    let max = 12288 * MIB_BYTES;
    let swapMax = 4096 * MIB_BYTES;
    const { tracker, scripts, setSettings } = setup({
      stdout: () => supportedOutput([sampleLine({ managed: 1, high, max, swapMax })]),
    });
    await tracker.tick();
    setSettings({ memoryHighMb: 0, memoryMaxMb: 0, memorySwapMaxMb: 0 });
    await tracker.tick();
    const release = scripts.filter((s) => s.includes('MemoryHigh=infinity'));
    expect(release).toHaveLength(1);
    expect(release[0]).toContain('MemoryMax=infinity');
    expect(release[0]).toContain('MemorySwapMax=infinity');
    high = 0;
    max = 0;
    swapMax = 0;
    await tracker.tick();
    expect(scripts.filter((s) => s.includes('set-property'))).toHaveLength(1);
  });

  test('change detection suppresses small current deltas and heartbeats every 30s', async () => {
    let current = MIB_BYTES;
    const { clock, tracker, samples } = setup({
      stdout: () => supportedOutput([sampleLine({ current, managed: 1, high: 8192 * MIB_BYTES })]),
    });
    await tracker.tick();
    expect(samples).toHaveLength(1);
    current += 100;
    await tracker.tick();
    expect(samples).toHaveLength(1);
    current += MIB_BYTES;
    await tracker.tick();
    expect(samples).toHaveLength(2);
    await clock.advance(30_000);
    await tracker.tick();
    expect(samples).toHaveLength(3);
  });

  test('oom_kill increase marks the window and emits an event', async () => {
    let oomKill = 0;
    const { tracker, oomEvents, marks } = setup({
      stdout: () => supportedOutput([sampleLine({ oomKill, managed: 1 })]),
    });
    await tracker.tick();
    expect(oomEvents).toEqual([]);
    oomKill = 2;
    await tracker.tick();
    expect(oomEvents).toEqual([
      expect.objectContaining({
        deviceId: 'dev-1',
        windowId: '@1',
        paneId: '%1',
        scope: 'tmux-spawn-abc.scope',
        oomKills: 2,
      }),
    ]);
    expect(marks.has('dev-1/@1')).toBe(true);
  });

  test('vanished window clears the oom mark after two missed ticks', async () => {
    const { tracker, marks, setPanes } = setup({
      stdout: supportedOutput([sampleLine({ oomKill: 1, managed: 1 })]),
    });
    await tracker.tick();
    expect(marks.has('dev-1/@1')).toBe(true);
    setPanes([]);
    await tracker.tick();
    expect(marks.has('dev-1/@1')).toBe(true);
    await tracker.tick();
    expect(marks.has('dev-1/@1')).toBe(false);
  });

  test('persisted marks for absent windows clear after two misses', async () => {
    const { tracker, marks } = setup({
      panes: [{ paneId: '%2', windowId: '@2', windowName: 'other', pid: 99 }],
      stdout: supportedOutput([sampleLine({ paneId: '%2', pid: 99, scope: '-', managed: 0 })]),
      initialMarks: [['dev-1', '@1']],
    });
    expect(marks.has('dev-1/@1')).toBe(true);
    await tracker.tick();
    expect(marks.has('dev-1/@1')).toBe(true);
    await tracker.tick();
    expect(marks.has('dev-1/@1')).toBe(false);
  });

  test('enabled=false keeps sampling at the normal interval and still emits', async () => {
    const { clock, tracker, scripts, samples } = setup({ settings: { enabled: false } });
    tracker.start();
    await flush();
    expect(scripts.filter((script) => script.includes('VTMEM'))).toHaveLength(1);
    expect(scripts.filter((script) => isOrphanSweepScript(script))).toHaveLength(1);
    expect(scripts.some((script) => script.includes('set-property'))).toBe(false);
    expect(samples).toHaveLength(1);
    const firstAt = tracker.getWindows()[0]?.sampledAt;
    await clock.advance(5_000);
    expect(scripts.filter((script) => script.includes('VTMEM'))).toHaveLength(2);
    expect(tracker.getWindows()[0]?.sampledAt).toBeGreaterThan(firstAt ?? 0);
    await clock.advance(55_000);
    expect(scripts.filter((script) => script.includes('VTMEM')).length).toBeGreaterThan(2);
  });

  test('enabled=false releases again while the next sample is still finite', async () => {
    let high = 8192 * MIB_BYTES;
    let max = 12288 * MIB_BYTES;
    let swapMax = 4096 * MIB_BYTES;
    const { tracker, scripts, samples, setSettings } = setup({
      stdout: () => supportedOutput([sampleLine({ managed: 1, high, max, swapMax })]),
    });
    await tracker.tick();
    setSettings({ enabled: false });
    await tracker.tick();
    await tracker.tick();
    const release = scripts.filter((script) => script.includes('MemoryHigh=infinity'));
    expect(release).toHaveLength(2);
    expect(release[0]).toContain('MemoryMax=infinity');
    expect(release[0]).toContain('MemorySwapMax=infinity');
    expect(release[0]?.indexOf('DBUS_SESSION_BUS_ADDRESS') ?? -1).toBeLessThan(
      release[0]?.indexOf('systemctl') ?? 0
    );
    expect(tracker.getWindows()[0]?.high).toBe(high);
    high = 0;
    max = 0;
    swapMax = 0;
    await tracker.tick();
    expect(scripts.filter((script) => script.includes('set-property'))).toHaveLength(2);
    expect(samples.at(-1)?.[0]?.high).toBe(0);
    expect(samples.at(-1)?.[0]?.max).toBe(0);
    expect(tracker.getWindows()[0]?.high).toBe(0);
  });

  test('prune still runs when disabled', async () => {
    const { tracker, marks, setSettings, setPanes } = setup({
      stdout: supportedOutput([sampleLine({ oomKill: 1, managed: 1 })]),
    });
    await tracker.tick();
    expect(marks.has('dev-1/@1')).toBe(true);
    setSettings({ enabled: false });
    setPanes([]);
    await tracker.tick();
    expect(marks.has('dev-1/@1')).toBe(true);
    await tracker.tick();
    expect(marks.has('dev-1/@1')).toBe(false);
  });

  test('stopScopesForWindow runs systemctl stop and clears the oom mark', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    const { tracker, scripts, marks } = setup({
      stdout: supportedOutput([sampleLine({ oomKill: 1, managed: 1 })]),
    });
    await tracker.tick();
    expect(marks.has('dev-1/@1')).toBe(true);
    const before = scripts.length;
    await tracker.stopScopesForWindow('@1');
    expect(scripts[before]).toContain("systemctl --user stop 'tmux-spawn-abc.scope'");
    expect(
      info.mock.calls.some((args) => String(args[0]).includes('[tmux] stop-scope window=@1'))
    ).toBe(true);
    expect(marks.has('dev-1/@1')).toBe(false);
    info.mockRestore();
  });

  test('apply set-property failure retries once after 60s then logs give-up and stops', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { clock, tracker, scripts } = setup({
      run: (script) => {
        if (script.includes('set-property')) {
          return { stdout: '', stderr: 'denied', exitCode: 1 };
        }
        return { stdout: supportedOutput([sampleLine({ managed: 0 })]), stderr: '', exitCode: 0 };
      },
    });
    await tracker.tick();
    expect(scripts.filter((s) => s.includes('set-property'))).toHaveLength(1);
    await clock.advance(59_000);
    await tracker.tick();
    expect(scripts.filter((s) => s.includes('set-property'))).toHaveLength(1);
    await clock.advance(1_000);
    await tracker.tick();
    expect(scripts.filter((s) => s.includes('set-property'))).toHaveLength(2);
    expect(
      warn.mock.calls.some(
        (args) =>
          String(args[0]).includes('set-property giving up') && String(args[0]).includes('denied')
      )
    ).toBe(true);
    await clock.advance(60_000);
    await tracker.tick();
    expect(scripts.filter((s) => s.includes('set-property'))).toHaveLength(2);
    warn.mockRestore();
  });

  test('release failure keeps retrying after the give-up line', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { clock, tracker, scripts } = setup({
      settings: { enabled: false },
      stdout: supportedOutput([
        sampleLine({
          managed: 1,
          high: 8192 * MIB_BYTES,
          max: 12288 * MIB_BYTES,
          swapMax: 4096 * MIB_BYTES,
        }),
      ]),
      run: (script) => {
        if (script.includes('set-property')) {
          return { stdout: '', stderr: 'Failed to connect to bus', exitCode: 1 };
        }
        return {
          stdout: supportedOutput([
            sampleLine({
              managed: 1,
              high: 8192 * MIB_BYTES,
              max: 12288 * MIB_BYTES,
              swapMax: 4096 * MIB_BYTES,
            }),
          ]),
          stderr: '',
          exitCode: 0,
        };
      },
    });
    await tracker.tick();
    expect(scripts.filter((script) => script.includes('set-property'))).toHaveLength(1);
    await clock.advance(60_000);
    await tracker.tick();
    expect(scripts.filter((script) => script.includes('set-property'))).toHaveLength(2);
    expect(
      warn.mock.calls.some(
        (args) =>
          String(args[0]).includes('release giving up') &&
          String(args[0]).includes('Failed to connect to bus')
      )
    ).toBe(true);
    await clock.advance(60_000);
    await tracker.tick();
    expect(scripts.filter((script) => script.includes('set-property'))).toHaveLength(3);
    warn.mockRestore();
  });

  test('limitsSupported=false still releases a named scope', async () => {
    const line = sampleLine({
      managed: 1,
      high: 8192 * MIB_BYTES,
      max: 12288 * MIB_BYTES,
      swapMax: 4096 * MIB_BYTES,
    });
    const { tracker, scripts } = setup({
      settings: { enabled: false },
      stdout: headerOutput(0, 'no-user-systemd', [line]),
    });
    for (let i = 0; i < 7; i++) await tracker.tick();
    expect(tracker.limitsSupported).toBe(false);
    expect(scripts.filter((script) => script.includes('set-property'))).toHaveLength(7);
    expect(scripts.some((script) => script.includes('MemoryMax=infinity'))).toBe(true);
  });

  test('disabled sweep releases only orphan scopes owned by this tmux server', async () => {
    const slice = '/user.slice/user-1.slice/user@1.service/app.slice';
    const sweepStdout = [
      'VTORPHAN 1 ok',
      `SERVER\t99\t${slice}/tmux.scope`,
      `UNIT\ttmux-spawn-orphan.scope\t99\t${slice}/tmux-spawn-orphan.scope\t100\t200\t300\t0`,
      `UNIT\ttmux-spawn-other.scope\t555\t${slice}/tmux-spawn-other.scope\t100\t200\t300\t0`,
      'UNIT\ttmux-spawn-foreign.scope\t99\t/other.slice/app.slice/tmux-spawn-foreign.scope\t100\t200\t300\t0',
      `UNIT\ttmux-spawn-abc.scope\t99\t${slice}/tmux-spawn-abc.scope\t100\t200\t300\t0`,
    ].join('\n');
    const { tracker, scripts } = setup({
      settings: { enabled: false },
      stdout: supportedOutput([sampleLine({ high: 100, max: 200, swapMax: 300 })]),
      sweepStdout,
    });
    await tracker.tick();
    const releases = scripts.filter((script) => script.includes('set-property'));
    expect(releases.filter((script) => script.includes('tmux-spawn-orphan.scope'))).toHaveLength(1);
    expect(releases.filter((script) => script.includes('tmux-spawn-abc.scope'))).toHaveLength(1);
    expect(releases.some((script) => script.includes('tmux-spawn-other.scope'))).toBe(false);
    expect(releases.some((script) => script.includes('tmux-spawn-foreign.scope'))).toBe(false);
    const orphan = releases.find((script) => script.includes('tmux-spawn-orphan.scope'));
    expect(orphan).toContain('MemoryHigh=infinity');
    expect(orphan?.indexOf('DBUS_SESSION_BUS_ADDRESS') ?? -1).toBeLessThan(
      orphan?.indexOf('systemctl') ?? 0
    );
    await tracker.tick();
    expect(scripts.filter((script) => script.includes('tmux-spawn-orphan.scope'))).toHaveLength(2);
  });
});
