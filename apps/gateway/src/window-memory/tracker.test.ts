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
  return [`VTMEM 1 ${uid} 1`, ...lines].join('\n');
}

function setup(opts?: {
  settings?: Partial<WindowMemorySettings>;
  panes?: PaneRef[];
  run?: (script: string) => HostShellResult | Promise<HostShellResult>;
  stdout?: string | ((script: string) => string);
  exitCode?: number;
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
  test('unsupported stops the timer after one host call', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    const { clock, tracker, scripts, support } = setup({ stdout: 'VTMEM 1 1000 0\n' });
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

  test('vanished window clears the oom mark', async () => {
    const { tracker, marks, setPanes } = setup({
      stdout: supportedOutput([sampleLine({ oomKill: 1, managed: 1 })]),
    });
    await tracker.tick();
    expect(marks.has('dev-1/@1')).toBe(true);
    setPanes([]);
    await tracker.tick();
    expect(marks.has('dev-1/@1')).toBe(false);
  });

  test('enabled=false makes no host calls', async () => {
    const { tracker, scripts } = setup({ settings: { enabled: false } });
    await tracker.tick();
    tracker.start();
    await flush();
    expect(scripts).toEqual([]);
  });

  test('stopScopesForWindow runs systemctl stop for known scopes', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    const { tracker, scripts } = setup({
      stdout: supportedOutput([sampleLine({ managed: 1 })]),
    });
    await tracker.tick();
    const before = scripts.length;
    await tracker.stopScopesForWindow('@1');
    expect(scripts[before]).toContain("systemctl --user stop 'tmux-spawn-abc.scope'");
    expect(
      info.mock.calls.some((args) => String(args[0]).includes('[tmux] stop-scope window=@1'))
    ).toBe(true);
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
