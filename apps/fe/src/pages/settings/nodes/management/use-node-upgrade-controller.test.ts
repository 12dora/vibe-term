// 编排层的挂载时序：`useUpgradeRestore` 必须比 `useUpgradeBatch` 的续跑先注册 effect。
//
// 复现的是刷新后最常见的一种顺序——latest 先回来，节点列表随后到。列表落地的那一帧两个 effect
// 一起跑：续跑要是排在前面，`restoreActive` 还是 0、`inFlight` 还是空，仍在升级的节点会被重发
// 一次 POST（撞 `UPGRADE_IN_PROGRESS`），随后回读又因为该行已被标记 running 而跳过。
//
// bun test 没有 DOM，跑不起 react-dom；这里用一个只实现 useState / useRef / useCallback /
// useMemo / useEffect 的迷你 hooks 运行时驱动 `useNodeUpgrade`，语义上保证两件事：effect 按注册
// 顺序刷新，状态更新触发重渲染。`react` / `react-i18next` 的 mock 在 harness 未激活时原样转发，
// 免得污染同进程里的其他测试文件。

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import type { UpgradeStatus } from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';
import * as ReactRuntime from 'react';
import * as ReactI18nRuntime from 'react-i18next';
import type { NodeUpgradeController } from './types';
import type { UpgradeIo } from './use-node-upgrade';

installWindowStorage();

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

type Updater = unknown;

function harnessUseState(initial: unknown): [unknown, (update: Updater) => void] {
  const slot = slotAt();
  if (slot.deps === null) {
    slot.deps = [];
    const set = (update: Updater) => {
      const pair = slot.value as [unknown, (update: Updater) => void];
      const next =
        typeof update === 'function' ? (update as (prev: unknown) => unknown)(pair[0]) : update;
      if (Object.is(next, pair[0])) return;
      slot.value = [next, set];
      if (host) host.dirty = true;
    };
    slot.value = [typeof initial === 'function' ? (initial as () => unknown)() : initial, set];
  }
  return slot.value as [unknown, (update: Updater) => void];
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

const translate = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

type AnyFn = (...args: never[]) => unknown;

// `mock.module` 连已有的 namespace 一起换成 mock：转发目标必须在打桩前先抓下来，
// 否则「harness 未激活时转发给真实实现」会变成自己调自己，一路递归到卡死。
const realReact = {
  useState: ReactRuntime.useState as AnyFn,
  useRef: ReactRuntime.useRef as AnyFn,
  useCallback: ReactRuntime.useCallback as AnyFn,
  useMemo: ReactRuntime.useMemo as AnyFn,
  useEffect: ReactRuntime.useEffect as AnyFn,
};
const realUseTranslation = ReactI18nRuntime.useTranslation as AnyFn;

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

mock.module('react-i18next', () => ({
  ...ReactI18nRuntime,
  useTranslation: (...args: unknown[]) =>
    host ? { t: translate, i18n: {}, ready: true } : realUseTranslation(...(args as never[])),
}));

const { useNodeUpgrade } = await import('./use-node-upgrade-controller');
const { createBatchPlan, currentTabId, saveBatchPlan } = await import('./upgrade-batch-storage');

const LATEST = '1.2.0';
const SELF_ID = 'self-node';
const NODE_ID = 'n1-node';

function row(overrides: Partial<NodeRow> & { id: string }): NodeRow {
  return {
    runtimeNodeId: overrides.id,
    name: overrides.id,
    publicKey: '',
    fingerprint: '',
    online: true,
    reach: 'lan',
    transport: null,
    rttMs: null,
    version: '1.1.30',
    directCapable: false,
    loggedIn: true,
    inventory: null,
    isSelf: false,
    isHub: false,
    lastSeenAt: null,
    status: null,
    certificate: null,
    certSig: null,
    ...overrides,
  };
}

function status(overrides: Partial<UpgradeStatus> = {}): UpgradeStatus {
  return { state: 'idle', targetVersion: null, error: null, startedAt: null, ...overrides };
}

/** 迷你渲染器：一次 `act()` 走「渲染 → 按注册顺序刷 effect → 状态还脏就再来一轮」。 */
function mountController(read: () => NodeRow[], io: UpgradeIo, onChanged: () => void) {
  host = { slots: [], index: 0, queue: [], dirty: false };
  let controller: NodeUpgradeController | null = null;
  const runHook = useNodeUpgrade;

  const pass = () => {
    const current = host as Host;
    current.index = 0;
    current.dirty = false;
    controller = runHook(read(), onChanged, io);
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
      // 渲染期 setState：不刷 effect，直接再渲染一轮。
      if ((host as Host).dirty) continue;
      flush();
      if (!(host as Host).dirty) return controller as NodeUpgradeController;
    }
    throw new Error('render loop did not settle');
  };

  const unmount = () => {
    const current = host as Host;
    for (const slot of current.slots) slot.cleanup?.();
    host = null;
  };

  act();
  return { act, unmount };
}

async function settle(times = 200): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('useNodeUpgrade 的挂载时序', () => {
  const realFetch = globalThis.fetch;
  let clock = 1_700_000_000_000;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    if (host) {
      for (const slot of host.slots) slot.cleanup?.();
      host = null;
    }
    globalThis.fetch = realFetch;
    globalThis.localStorage.clear();
  });

  test('latest 先于节点列表返回：仍在升级的节点只被回读，不会被批量续跑重发 POST', async () => {
    saveBatchPlan(
      createBatchPlan({
        entryNodeId: SELF_ID,
        targetVersion: LATEST,
        order: [[NODE_ID]],
        now: clock,
        tabId: currentTabId(),
      })
    );

    globalThis.fetch = ((input: string) =>
      Promise.resolve(
        String(input).includes('/api/mesh/upgrade/latest')
          ? Response.json({ latestVersion: LATEST })
          : new Response(null, { status: 404 })
      )) as typeof fetch;

    const starts: string[] = [];
    const polls: string[] = [];
    let active = 20;
    const io: UpgradeIo = {
      start: async (nodeId) => {
        starts.push(nodeId);
        return { kind: 'started', status: status({ state: 'downloading', targetVersion: LATEST }) };
      },
      poll: async (nodeId) => {
        polls.push(nodeId);
        if (nodeId !== NODE_ID) return { kind: 'status', status: status() };
        active -= 1;
        return active > 0
          ? { kind: 'status', status: status({ state: 'executing', targetVersion: LATEST }) }
          : { kind: 'status', status: status() };
      },
      cancel: async () => ({ kind: 'failed', code: 'UPGRADE_NOT_RUNNING', httpStatus: 409 }),
      nodeVersion: async () => LATEST,
      wait: async () => {
        clock += 2_000;
        return true;
      },
      now: () => clock,
    };

    // 第一帧：节点列表还没到，只有 latest 的请求在飞。
    let rows: NodeRow[] = [];
    const harness = mountController(
      () => rows,
      io,
      () => undefined
    );
    await settle(20);
    harness.act();
    expect(starts).toEqual([]);

    // latest 已经回来，节点列表这时才落地——回读与续跑的 effect 在同一帧里排队。
    rows = [
      row({ id: SELF_ID, isSelf: true, version: LATEST }),
      row({ id: NODE_ID, version: '1.1.30' }),
    ];
    harness.act();

    // 这一帧里续跑一定还没动手：回读刚把 restoreActive 抬起来。
    expect(starts).toEqual([]);

    await settle();
    harness.act();
    await settle();

    // 全程只有回读的 GET 接管了这台机器，没有第二次 POST。
    expect(starts).toEqual([]);
    expect(polls).toContain(NODE_ID);
    expect(polls.filter((id) => id === NODE_ID).length).toBeGreaterThan(1);

    harness.unmount();
  });

  test('计划里的节点已经空闲：回读收尾后续跑照常发 POST', async () => {
    saveBatchPlan(
      createBatchPlan({
        entryNodeId: SELF_ID,
        targetVersion: LATEST,
        order: [[NODE_ID]],
        now: clock,
        tabId: currentTabId(),
      })
    );

    globalThis.fetch = ((input: string) =>
      Promise.resolve(
        String(input).includes('/api/mesh/upgrade/latest')
          ? Response.json({ latestVersion: LATEST })
          : new Response(null, { status: 404 })
      )) as typeof fetch;

    const starts: string[] = [];
    const io: UpgradeIo = {
      start: async (nodeId) => {
        starts.push(nodeId);
        return { kind: 'started', status: status({ state: 'downloading', targetVersion: LATEST }) };
      },
      poll: async () => ({ kind: 'status', status: status() }),
      cancel: async () => ({ kind: 'failed', code: 'UPGRADE_NOT_RUNNING', httpStatus: 409 }),
      nodeVersion: async () => LATEST,
      wait: async () => {
        clock += 2_000;
        return true;
      },
      now: () => clock,
    };

    let rows: NodeRow[] = [];
    const harness = mountController(
      () => rows,
      io,
      () => undefined
    );
    await settle(20);
    harness.act();

    rows = [
      row({ id: SELF_ID, isSelf: true, version: LATEST }),
      row({ id: NODE_ID, version: '1.1.30' }),
    ];
    harness.act();
    await settle();
    harness.act();
    await settle();

    expect(starts).toEqual([NODE_ID]);

    harness.unmount();
  });
});
