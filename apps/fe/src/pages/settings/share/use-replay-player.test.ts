// 播放机：从 cursor 0 一跳到片尾必须把 checkpoint 之后的 out 全部写进终端。
// bun test 无 DOM，react-dom 跑不起来；seek/apply 已抽成纯函数，hook 用迷你运行时驱动 effect。

import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { ShareLogEntry } from '@vibeterm/shared/share';
import * as ReactRuntime from 'react';
import { buildReplayTimeline } from './replay-timeline';
import type { ReplayTerminalHandle } from './use-replay-terminal';

type Slot = { value: unknown; deps: unknown[] | null; cleanup: (() => void) | undefined };
type Host = {
  slots: Slot[];
  index: number;
  queue: Array<{ slot: Slot; create: () => (() => void) | undefined }>;
  dirty: boolean;
};

let host: Host | null = null;

function slotAt(): Slot {
  const current = host;
  if (!current) throw new Error('hook called outside the harness');
  const existing = current.slots[current.index];
  const slot: Slot = existing ?? { value: undefined, deps: null, cleanup: undefined };
  if (!existing) current.slots[current.index] = slot;
  current.index += 1;
  return slot;
}

function depsChanged(prev: unknown[] | null, next: readonly unknown[] | undefined): boolean {
  if (prev === null || next === undefined) return true;
  return prev.length !== next.length || prev.some((value, i) => !Object.is(value, next[i]));
}

function harnessUseState(initial: unknown): [unknown, (update: unknown) => void] {
  const slot = slotAt();
  if (slot.deps === null) {
    slot.deps = [];
    const set = (update: unknown) => {
      const pair = slot.value as [unknown, (update: unknown) => void];
      const next =
        typeof update === 'function' ? (update as (prev: unknown) => unknown)(pair[0]) : update;
      if (Object.is(next, pair[0])) return;
      slot.value = [next, set];
      if (host) host.dirty = true;
    };
    slot.value = [typeof initial === 'function' ? (initial as () => unknown)() : initial, set];
  }
  return slot.value as [unknown, (update: unknown) => void];
}

function harnessUseRef(initial: unknown): { current: unknown } {
  const slot = slotAt();
  if (slot.deps === null) {
    slot.deps = [];
    slot.value = { current: initial };
  }
  return slot.value as { current: unknown };
}

function harnessMemoized(compute: () => unknown, deps: readonly unknown[] | undefined): unknown {
  const slot = slotAt();
  if (depsChanged(slot.deps, deps)) {
    slot.deps = deps ? [...deps] : null;
    slot.value = compute();
  }
  return slot.value;
}

function harnessUseEffect(
  create: () => (() => void) | undefined,
  deps: readonly unknown[] | undefined
): void {
  const slot = slotAt();
  if (!depsChanged(slot.deps, deps)) return;
  slot.deps = deps ? [...deps] : null;
  host?.queue.push({ slot, create });
}

type AnyFn = (...args: never[]) => unknown;
const realReact = {
  useState: ReactRuntime.useState as AnyFn,
  useRef: ReactRuntime.useRef as AnyFn,
  useCallback: ReactRuntime.useCallback as AnyFn,
  useMemo: ReactRuntime.useMemo as AnyFn,
  useEffect: ReactRuntime.useEffect as AnyFn,
};

mock.module('react', () => ({
  ...ReactRuntime,
  useState: (initial: unknown) =>
    host ? harnessUseState(initial) : realReact.useState(initial as never),
  useRef: (initial: unknown) =>
    host ? harnessUseRef(initial) : realReact.useRef(initial as never),
  useCallback: (fn: unknown, deps: readonly unknown[] | undefined) =>
    host ? harnessMemoized(() => fn, deps) : realReact.useCallback(fn as never, deps as never),
  useMemo: (factory: () => unknown, deps: readonly unknown[] | undefined) =>
    host ? harnessMemoized(factory, deps) : realReact.useMemo(factory as never, deps as never),
  useEffect: (create: () => (() => void) | undefined, deps: readonly unknown[] | undefined) =>
    host ? harnessUseEffect(create, deps) : realReact.useEffect(create as never, deps as never),
}));

const { applyReplaySeek, useReplayPlayer } = await import('./use-replay-player');
type ReplayPlayer = ReturnType<typeof useReplayPlayer>;

const BASE = 1_700_000_000_000;

function entry(partial: Partial<ShareLogEntry> & { seq: number; at: number }): ShareLogEntry {
  return {
    kind: 'out',
    paneId: '%1',
    data: '',
    ...partial,
  } as ShareLogEntry;
}

function b64(text: string): string {
  return btoa(text);
}

function sampleTimeline() {
  return buildReplayTimeline([
    entry({
      seq: 1,
      at: BASE,
      kind: 'checkpoint',
      data: b64('CKPT'),
      cols: 80,
      rows: 24,
    }),
    entry({ seq: 2, at: BASE + 400, data: b64('ONE') }),
    entry({ seq: 3, at: BASE + 800, data: b64('TWO') }),
    entry({ seq: 4, at: BASE + 1200, data: b64('THREE') }),
  ]);
}

function fakeTerminal(): ReplayTerminalHandle & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    write(data) {
      events.push(`write:${new TextDecoder().decode(data)}`);
    },
    resize(cols, rows) {
      events.push(`resize:${cols}x${rows}`);
    },
    reset() {
      events.push('reset');
    },
    fit() {
      events.push('fit');
    },
  };
}

function writtenText(events: string[]): string {
  return events
    .filter((item) => item.startsWith('write:'))
    .map((item) => item.slice(6))
    .join('');
}

function mountPlayer(
  timeline: ReturnType<typeof sampleTimeline>,
  terminal: ReplayTerminalHandle,
  ready: boolean
) {
  host = { slots: [], index: 0, queue: [], dirty: false };
  let player: ReplayPlayer | null = null;
  let currentReady = ready;
  let currentGeneration = ready ? 1 : 0;

  const pass = () => {
    const current = host as Host;
    current.index = 0;
    current.dirty = false;
    player = useReplayPlayer(timeline, terminal, currentReady, currentGeneration);
  };

  const flush = () => {
    const current = host as Host;
    const queued = current.queue;
    current.queue = [];
    for (const item of queued) {
      item.slot.cleanup?.();
      item.slot.cleanup = item.create();
    }
  };

  const act = () => {
    for (let guard = 0; guard < 100; guard += 1) {
      pass();
      if ((host as Host).dirty) continue;
      flush();
      if (!(host as Host).dirty) return player as ReplayPlayer;
    }
    throw new Error('render loop did not settle');
  };

  const setReady = (next: boolean) => {
    currentReady = next;
    if (next) currentGeneration += 1;
    return act();
  };

  /** 改字号那一类重建：ready 可能一直是 true，只有代次变了。 */
  const reboot = () => {
    currentGeneration += 1;
    return act();
  };

  act();
  return {
    player: () => player as ReplayPlayer,
    act,
    setReady,
    reboot,
  };
}

afterEach(() => {
  if (host) {
    for (const slot of host.slots) slot.cleanup?.();
    host = null;
  }
});

describe('applyReplaySeek', () => {
  test('从 cursor 0 跳到 durationMs 写入全部 out', () => {
    const timeline = sampleTimeline();
    const terminal = fakeTerminal();
    const pane = timeline.panes[0];
    const result = applyReplaySeek({
      pane,
      targetMs: timeline.durationMs,
      cursor: 0,
      force: false,
      terminal,
    });
    expect(result.cursor).toBe(pane.events.length);
    expect(writtenText(terminal.events)).toBe('CKPTONETWOTHREE');
  });

  test('就绪时先落到 checkpoint，再 seek 到片尾补写后续 out', () => {
    const timeline = sampleTimeline();
    const terminal = fakeTerminal();
    const pane = timeline.panes[0];
    const atStart = applyReplaySeek({
      pane,
      targetMs: 0,
      cursor: 0,
      force: true,
      terminal,
    });
    expect(writtenText(terminal.events)).toBe('CKPT');
    applyReplaySeek({
      pane,
      targetMs: timeline.durationMs,
      cursor: atStart.cursor,
      force: false,
      terminal,
    });
    expect(writtenText(terminal.events)).toBe('CKPTONETWOTHREE');
  });
});

describe('useReplayPlayer seek', () => {
  test('seek(durationMs) 从 cursor 0 写入全部 out', () => {
    const timeline = sampleTimeline();
    const terminal = fakeTerminal();
    const mounted = mountPlayer(timeline, terminal, true);
    expect(writtenText(terminal.events)).toBe('CKPT');
    mounted.player().seek(timeline.durationMs);
    mounted.act();
    expect(writtenText(terminal.events)).toBe('CKPTONETWOTHREE');
  });

  test('未就绪时 seek 到片尾，就绪后仍写出全部 out', () => {
    const timeline = sampleTimeline();
    const terminal = fakeTerminal();
    const mounted = mountPlayer(timeline, terminal, false);
    mounted.player().seek(timeline.durationMs);
    mounted.act();
    expect(writtenText(terminal.events)).toBe('');
    mounted.setReady(true);
    expect(writtenText(terminal.events)).toBe('CKPTONETWOTHREE');
  });

  test('ready 不翻转、只换实例代次时照样清空重放到当前时刻', () => {
    const timeline = sampleTimeline();
    const terminal = fakeTerminal();
    const mounted = mountPlayer(timeline, terminal, true);
    mounted.player().seek(timeline.durationMs);
    mounted.act();
    terminal.events.length = 0;
    mounted.reboot();
    expect(terminal.events[0]).toBe('reset');
    expect(terminal.events).toContain('resize:80x24');
    expect(writtenText(terminal.events)).toBe('CKPTONETWOTHREE');
  });
});
