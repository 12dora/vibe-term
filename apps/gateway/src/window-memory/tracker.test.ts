import { describe, expect, spyOn, test } from 'bun:test';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS, type WindowMemorySettings } from '@vibeterm/shared';

import { MIB_BYTES } from './constants';
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
}): string {
  return [
    opts.paneId ?? '%1',
    String(opts.pid ?? 4242),
    opts.scope ?? 'tmux-spawn-abc.scope',
    String(opts.current ?? 0),
    String(opts.high ?? 0),
    String(opts.max ?? 0),
    String(opts.swapMax ?? 0),
    String(opts.oomKill ?? 0),
    String(opts.managed ?? 0),
  ].join('\t');
}

function supportedOutput(lines: string[], uid = 1000): string {
  return [`VTMEM 1 ${uid} 1 ok`, ...lines].join('\n');
}

function setup(opts?: {
  settings?: Partial<WindowMemorySettings>;
  panes?: PaneRef[];
  run?: (script: string) => HostShellResult | Promise<HostShellResult>;
  stdout?: string | ((script: string) => string);
  exitCode?: number;
  initialMarks?: Array<[string, string]>;
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
  test('unsupported no-cgroup2 stops the timer after one host call', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    const { clock, tracker, scripts, support } = setup({
      stdout: 'VTMEM 1 1000 0 no-cgroup2\n',
    });
    tracker.start();
    await flush();
    expect(support).toEqual([false]);
    expect(tracker.supported).toBe(false);
    expect(scripts).toHaveLength(1);
    expect(
      info.mock.calls.some((args) => String(args[0]).includes('unsupported device=dev-1'))
    ).toBe(true);
    await clock.advance(60_000);
    expect(scripts).toHaveLength(1);
    info.mockRestore();
  });

  test('transient no-user-systemd keeps sampling and recovers', async () => {
    let header = 'VTMEM 1 1000 0 no-user-systemd\n';
    const { tracker, scripts, support } = setup({ stdout: () => header });
    await tracker.tick();
    await tracker.tick();
    expect(tracker.supported).toBeNull();
    expect(support).toEqual([]);
    expect(scripts).toHaveLength(2);
    header = supportedOutput([sampleLine({ managed: 0 })]);
    await tracker.tick();
    expect(tracker.supported).toBe(true);
    expect(support).toEqual([true]);
  });

  test('pins unsupported after 6 consecutive no-user-systemd then recovers', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    let header = 'VTMEM 1 1000 0 no-user-systemd\n';
    const { clock, tracker, scripts, support } = setup({ stdout: () => header });
    tracker.start();
    await flush();
    for (let i = 0; i < 5; i++) await clock.advance(5_000);
    expect(tracker.supported).toBe(false);
    expect(support).toEqual([false]);
    expect(scripts).toHaveLength(6);
    const unsupportedLogs = info.mock.calls.filter((args) =>
      String(args[0]).includes('unsupported device=dev-1')
    );
    expect(unsupportedLogs).toHaveLength(1);
    await clock.advance(5_000);
    expect(scripts).toHaveLength(7);
    header = supportedOutput([sampleLine({ managed: 0 })]);
    await clock.advance(5_000);
    expect(tracker.supported).toBe(true);
    expect(support).toEqual([false, true]);
    info.mockRestore();
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

  test('enabled=false samples once to release then skips emission', async () => {
    const { clock, tracker, scripts, samples } = setup({ settings: { enabled: false } });
    tracker.start();
    await flush();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).not.toContain('set-property');
    expect(samples).toEqual([]);
    await clock.advance(60_000);
    expect(scripts).toHaveLength(1);
  });

  test('enabled=false releases managed scopes then cheap-ticks', async () => {
    const { tracker, scripts, samples, setSettings } = setup({
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
    const before = scripts.length;
    setSettings({ enabled: false });
    await tracker.tick();
    const release = scripts.slice(before).filter((s) => s.includes('MemoryHigh=infinity'));
    expect(release).toHaveLength(1);
    expect(release[0]).toContain('MemoryMax=infinity');
    expect(release[0]).toContain('MemorySwapMax=infinity');
    const samplesAfterDisable = samples.length;
    await tracker.tick();
    expect(scripts.filter((s) => s.includes('set-property'))).toHaveLength(1);
    expect(samples).toHaveLength(samplesAfterDisable);
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

  test('set-property failure retries once after 60s then gives up', async () => {
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
    await clock.advance(60_000);
    await tracker.tick();
    expect(scripts.filter((s) => s.includes('set-property'))).toHaveLength(2);
    warn.mockRestore();
  });
});
