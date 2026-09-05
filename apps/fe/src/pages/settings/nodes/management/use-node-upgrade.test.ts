// 批量升级：候选筛选、执行顺序（普通节点 → 远端 hub → 本机）、并发上限与汇总提示；
// 刷新后的状态恢复、批量的断点续跑与「停止升级」也在这里，
// 全部走注入的 `run` / `io`，不碰网络也不碰计时器。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import type { UpgradeStatus } from '@tmex/shared';
import { createMemoryStorage } from '@tmex/stores/test-utils';
import type { NodeUpgradeEntry, UpgradeRunOutcome } from './types';
import {
  BATCH_CONCURRENCY,
  MIN_REMOTE_UPGRADE_VERSION,
  eligibleUpgradeRows,
  isAtLatest,
  isBatchEligible,
  isTooOldForRemoteUpgrade,
  orderUpgradeGroups,
  resumeUpgradeBatch,
  runUpgradeBatch,
  upgradeBlockReason,
} from './upgrade-batch';
import {
  UPGRADE_BATCH_OWNER_STALE_MS,
  type UpgradeBatchPlan,
  batchOwnedByOtherTab,
  createBatchPlan,
  createBatchPlanSink,
  loadBatchPlan,
  saveBatchPlan,
} from './upgrade-batch-storage';
import {
  RESTORE_CONCURRENCY,
  SILENT_UPGRADE_TOASTS,
  type UpgradeCancelOutcome,
  type UpgradeCancelParams,
  type UpgradeIo,
  type UpgradePollOutcome,
  type UpgradeStartOutcome,
  type UpgradeToasts,
  cancelNodeUpgrade,
  createNodeAbortRegistry,
  createResumeQueue,
  createSemaphore,
  createUpgradeCancelGate,
  launchRowUpgrade,
  launchUpgradeBatch,
  pushProgressOf,
  reportBatchSummary,
  restorableRows,
  restoreUpgradeStates,
  retainKnownIds,
  runNodeUpgrade,
  upgradeErrorText,
  upgradePhaseText,
  watchUpgrade,
} from './use-node-upgrade';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

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
    version: '1.1.0',
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

interface Recorder {
  toasts: UpgradeToasts;
  log: Array<[keyof UpgradeToasts, string]>;
}

function recorder(): Recorder {
  const log: Array<[keyof UpgradeToasts, string]> = [];
  return {
    log,
    toasts: {
      success: (m) => log.push(['success', m]),
      info: (m) => log.push(['info', m]),
      warning: (m) => log.push(['warning', m]),
      error: (m) => log.push(['error', m]),
    },
  };
}

function status(overrides: Partial<UpgradeStatus> = {}): UpgradeStatus {
  return { state: 'idle', targetVersion: null, error: null, startedAt: null, ...overrides };
}

function stubIo(overrides: Partial<UpgradeIo> = {}): UpgradeIo {
  return {
    start: async () => ({ kind: 'cancelled' }),
    poll: async () => ({ kind: 'unreachable' }),
    cancel: async () => ({ kind: 'failed', code: 'UPGRADE_NOT_RUNNING', httpStatus: 409 }),
    nodeVersion: async () => undefined,
    wait: async () => true,
    now: () => 0,
    ...overrides,
  };
}

describe('远程升级的版本门槛', () => {
  test('低于 MIN_REMOTE_UPGRADE_VERSION 的节点不能远程升级', () => {
    expect(MIN_REMOTE_UPGRADE_VERSION).toBe('1.1.0');
    expect(isTooOldForRemoteUpgrade('1.0.9')).toBe(true);
    expect(isTooOldForRemoteUpgrade('0.9.0')).toBe(true);
    expect(isTooOldForRemoteUpgrade('1.1.0')).toBe(false);
    expect(isTooOldForRemoteUpgrade('1.2.0')).toBe(false);
  });

  test('版本未知或无法解析时不拦：后端才是权威', () => {
    expect(isTooOldForRemoteUpgrade(null)).toBe(false);
    expect(isTooOldForRemoteUpgrade('1.1.0_dev')).toBe(false);
    expect(isTooOldForRemoteUpgrade('')).toBe(false);
  });
});

describe('isAtLatest', () => {
  test('等于或高于 latest 都算最新', () => {
    expect(isAtLatest('1.2.0', '1.2.0')).toBe(true);
    expect(isAtLatest('1.3.0', '1.2.0')).toBe(true);
    expect(isAtLatest('1.1.9', '1.2.0')).toBe(false);
  });

  test('latest 未知或版本无法解析时一律 false', () => {
    expect(isAtLatest('1.2.0', null)).toBe(false);
    expect(isAtLatest(null, '1.2.0')).toBe(false);
    expect(isAtLatest('1.2.0_dev', '1.2.0')).toBe(false);
  });
});

describe('upgradeBlockReason', () => {
  test('离线与未登录的判定优先于版本', () => {
    expect(upgradeBlockReason(row({ id: 'a', online: false, version: '1.0.0' }), '1.2.0')).toBe(
      'offline'
    );
    expect(upgradeBlockReason(row({ id: 'a', loggedIn: false, version: '1.0.0' }), '1.2.0')).toBe(
      'loginRequired'
    );
    // 本机不需要「登录该节点」
    expect(
      upgradeBlockReason(row({ id: 'a', loggedIn: false, isSelf: true, version: '1.1.0' }), '1.2.0')
    ).toBeNull();
  });

  test('版本过旧与已是最新分别给出原因', () => {
    expect(upgradeBlockReason(row({ id: 'a', version: '1.0.9' }), '1.2.0')).toBe('tooOld');
    expect(upgradeBlockReason(row({ id: 'a', version: '1.2.0' }), '1.2.0')).toBe('atLatest');
    expect(upgradeBlockReason(row({ id: 'a', version: '1.3.0' }), '1.2.0')).toBe('atLatest');
    expect(upgradeBlockReason(row({ id: 'a', version: '1.1.9' }), '1.2.0')).toBeNull();
  });

  test('latest 未知或版本无法解析时按钮保持可用', () => {
    expect(upgradeBlockReason(row({ id: 'a', version: '1.1.9' }), null)).toBeNull();
    expect(upgradeBlockReason(row({ id: 'a', version: null }), '1.2.0')).toBeNull();
    expect(upgradeBlockReason(row({ id: 'a', version: '1.1.9_dev' }), '1.2.0')).toBeNull();
  });
});

describe('批量候选', () => {
  test('只收在线、已登录（或本机）、版本可解析且严格低于 latest 且不过旧的节点', () => {
    const rows = [
      row({ id: 'ok', version: '1.1.9' }),
      row({ id: 'self', version: '1.1.9', isSelf: true, loggedIn: false }),
      row({ id: 'latest', version: '1.2.0' }),
      row({ id: 'old', version: '1.0.9' }),
      row({ id: 'offline', version: '1.1.9', online: false }),
      row({ id: 'anon', version: '1.1.9', loggedIn: false }),
      row({ id: 'unknown', version: null }),
      row({ id: 'dev', version: '1.1.9_dev' }),
    ];
    expect(eligibleUpgradeRows(rows, '1.2.0').map((item) => item.id)).toEqual(['ok', 'self']);
  });

  test('latest 未知时没有任何候选', () => {
    expect(eligibleUpgradeRows([row({ id: 'a', version: '1.1.0' })], null)).toEqual([]);
    expect(isBatchEligible(row({ id: 'a', version: '1.1.0' }), null)).toBe(false);
  });
});

describe('orderUpgradeGroups', () => {
  test('普通节点 → 远端 hub → 本机，空组不占位', () => {
    const groups = orderUpgradeGroups([
      row({ id: 'self', isSelf: true }),
      row({ id: 'hub', isHub: true }),
      row({ id: 'a' }),
      row({ id: 'b' }),
    ]);
    expect(groups.map((group) => group.map((item) => item.id))).toEqual([
      ['a', 'b'],
      ['hub'],
      ['self'],
    ]);
    expect(orderUpgradeGroups([row({ id: 'a' })])).toHaveLength(1);
  });

  test('本机同时是 hub 时归到最后一组，不会被排两次', () => {
    const groups = orderUpgradeGroups([
      row({ id: 'me', isSelf: true, isHub: true }),
      row({ id: 'a' }),
    ]);
    expect(groups.map((group) => group.map((item) => item.id))).toEqual([['a'], ['me']]);
  });
});

describe('runUpgradeBatch', () => {
  /** 记录每个节点的 start / settle 顺序；`resolve` 手动放行，用来验证「上一组收尾才开下一组」。 */
  function gate() {
    const started: string[] = [];
    const settled: string[] = [];
    const release = new Map<string, () => void>();
    const run = (node: NodeRow, outcome: UpgradeRunOutcome = 'done') => {
      started.push(node.name);
      return new Promise<UpgradeRunOutcome>((resolve) => {
        release.set(node.name, () => {
          settled.push(node.name);
          resolve(outcome);
        });
      });
    };
    return { started, settled, release, run };
  }

  test('hub 与本机严格排在普通节点之后，且要等前一组全部收尾', async () => {
    const g = gate();
    const rows = [
      row({ id: 'self', name: 'self', isSelf: true }),
      row({ id: 'hub', name: 'hub', isHub: true }),
      row({ id: 'a', name: 'a' }),
      row({ id: 'b', name: 'b' }),
    ];
    const progress: number[] = [];
    const controller = new AbortController();
    const done = runUpgradeBatch({
      rows,
      signal: controller.signal,
      run: (node) => g.run(node),
      onProgress: (completed) => progress.push(completed),
    });

    await Promise.resolve();
    // 普通节点两台同时开跑，hub / self 还没动
    expect(g.started).toEqual(['a', 'b']);

    g.release.get('a')?.();
    await Promise.resolve();
    expect(g.started).toEqual(['a', 'b']);

    g.release.get('b')?.();
    await flush();
    expect(g.started).toEqual(['a', 'b', 'hub']);

    g.release.get('hub')?.();
    await flush();
    expect(g.started).toEqual(['a', 'b', 'hub', 'self']);

    g.release.get('self')?.();
    const summary = await done;
    expect(g.settled).toEqual(['a', 'b', 'hub', 'self']);
    expect(summary).toEqual({
      succeeded: 4,
      failed: 0,
      failedNames: [],
      cancelledCount: 0,
      cancelled: false,
    });
    expect(progress).toEqual([1, 2, 3, 4]);
  });

  test('普通节点并发上限为 3', async () => {
    const g = gate();
    const rows = ['a', 'b', 'c', 'd', 'e'].map((name) => row({ id: name, name }));
    const controller = new AbortController();
    const done = runUpgradeBatch({
      rows,
      signal: controller.signal,
      run: (node) => g.run(node),
      onProgress: () => undefined,
    });

    await flush();
    expect(BATCH_CONCURRENCY).toBe(3);
    expect(g.started).toEqual(['a', 'b', 'c']);

    g.release.get('b')?.();
    await flush();
    expect(g.started).toEqual(['a', 'b', 'c', 'd']);

    for (const name of ['a', 'c', 'd', 'e']) {
      g.release.get(name)?.();
      await flush();
    }
    await done;
    expect(g.started).toHaveLength(5);
  });

  test('成败统计：done / alreadyLatest 计成功，failed / timeout 计失败，cancelled 单独一档', async () => {
    const outcomes: Record<string, UpgradeRunOutcome> = {
      a: 'done',
      b: 'alreadyLatest',
      c: 'failed',
      d: 'timeout',
      e: 'cancelled',
    };
    const controller = new AbortController();
    const summary = await runUpgradeBatch({
      rows: Object.keys(outcomes).map((name) => row({ id: name, name })),
      signal: controller.signal,
      run: async (node) => outcomes[node.name] as UpgradeRunOutcome,
      onProgress: () => undefined,
    });
    expect(summary).toEqual({
      succeeded: 2,
      failed: 2,
      failedNames: ['c', 'd'],
      cancelledCount: 1,
      cancelled: false,
    });
  });

  test('中途取消：剩下的节点不再启动，结论标记为 cancelled', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const summary = await runUpgradeBatch({
      rows: ['a', 'b', 'c'].map((name) => row({ id: name, name })),
      signal: controller.signal,
      concurrency: 1,
      run: async (node) => {
        started.push(node.name);
        if (node.name === 'a') controller.abort();
        return 'done';
      },
      onProgress: () => undefined,
    });
    expect(started).toEqual(['a']);
    expect(summary.cancelled).toBe(true);
  });

  test('单个节点抛异常只算它自己失败：同组其余节点跑完，hub / self 照常接上', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const progress: number[] = [];
    const summary = await runUpgradeBatch({
      rows: [
        row({ id: 'self', name: 'self', isSelf: true }),
        row({ id: 'hub', name: 'hub', isHub: true }),
        row({ id: 'boom', name: 'boom' }),
        row({ id: 'a', name: 'a' }),
      ],
      signal: controller.signal,
      concurrency: 1,
      run: async (node) => {
        started.push(node.name);
        if (node.name === 'boom') throw new Error('network down');
        return 'done';
      },
      onProgress: (completed) => progress.push(completed),
    });
    expect(started).toEqual(['boom', 'a', 'hub', 'self']);
    expect(summary).toEqual({
      succeeded: 3,
      failed: 1,
      failedNames: ['boom'],
      cancelledCount: 0,
      cancelled: false,
    });
    // 进度不会因为异常断档，四台机器都记了账
    expect(progress).toEqual([1, 2, 3, 4]);
  });
});

describe('reportBatchSummary', () => {
  test('全成功只弹一条 success', () => {
    const rec = recorder();
    reportBatchSummary(t, rec.toasts, {
      succeeded: 3,
      failed: 0,
      failedNames: [],
      cancelledCount: 0,
      cancelled: false,
    });
    expect(rec.log).toEqual([['success', 'nodes.upgrade.allDone:{"success":3,"failed":0}']]);
  });

  test('有失败时弹 warning 并附上失败节点名', () => {
    const rec = recorder();
    reportBatchSummary(t, rec.toasts, {
      succeeded: 1,
      failed: 2,
      failedNames: ['a', 'b'],
      cancelledCount: 0,
      cancelled: false,
    });
    expect(rec.log).toHaveLength(1);
    expect(rec.log[0]?.[0]).toBe('warning');
    expect(rec.log[0]?.[1]).toContain('nodes.upgrade.allDoneWithFailures');
    expect(rec.log[0]?.[1]).toContain('"names":"anodes.upgrade.listSeparatorb"');
  });

  test('有用户中断时单独报一档「已取消」', () => {
    const rec = recorder();
    reportBatchSummary(t, rec.toasts, {
      succeeded: 2,
      failed: 0,
      failedNames: [],
      cancelledCount: 1,
      cancelled: false,
    });
    expect(rec.log).toEqual([
      ['info', 'nodes.upgrade.allDoneWithCancelled:{"success":2,"failed":0,"cancelled":1}'],
    ]);
  });

  test('既有失败又有中断：一条 warning 里三个数都在', () => {
    const rec = recorder();
    reportBatchSummary(t, rec.toasts, {
      succeeded: 1,
      failed: 1,
      failedNames: ['a'],
      cancelledCount: 2,
      cancelled: false,
    });
    expect(rec.log).toEqual([
      ['warning', 'nodes.upgrade.allDoneWithCancelled:{"success":1,"failed":1,"cancelled":2}'],
    ]);
  });

  test('被取消时不弹任何 toast', () => {
    const rec = recorder();
    reportBatchSummary(t, rec.toasts, {
      succeeded: 1,
      failed: 1,
      failedNames: ['a'],
      cancelledCount: 0,
      cancelled: true,
    });
    expect(rec.log).toEqual([]);
  });
});

describe('restorableRows', () => {
  test('只查在线且（本机或已登录）的行', () => {
    const rows = [
      row({ id: 'ok' }),
      row({ id: 'self', isSelf: true, loggedIn: false }),
      row({ id: 'offline', online: false }),
      row({ id: 'anon', loggedIn: false }),
    ];
    expect(restorableRows(rows).map((item) => item.id)).toEqual(['ok', 'self']);
  });
});

describe('restoreUpgradeStates', () => {
  const SCRIPT: Record<string, UpgradePollOutcome> = {
    dl: { kind: 'status', status: status({ state: 'downloading', targetVersion: '1.2.0' }) },
    exec: { kind: 'status', status: status({ state: 'executing', targetVersion: '1.2.0' }) },
    idle: { kind: 'status', status: status() },
    stopped: { kind: 'status', status: status({ error: 'UPGRADE_CANCELLED' }) },
    broken: { kind: 'status', status: status({ error: 'DOWNLOAD_FAILED' }) },
    down: { kind: 'unreachable' },
  };

  test('非 idle 的行交回调用方接管，idle 的行一律不复活', async () => {
    const seen: Array<[string, string]> = [];
    const polled: string[] = [];
    await restoreUpgradeStates({
      rows: [
        row({ id: 'dl' }),
        row({ id: 'exec' }),
        row({ id: 'idle' }),
        row({ id: 'stopped' }),
        row({ id: 'broken' }),
        row({ id: 'down' }),
        row({ id: 'offline', online: false }),
        row({ id: 'anon', loggedIn: false }),
      ],
      io: stubIo({
        poll: async (nodeId) => {
          polled.push(nodeId);
          return SCRIPT[nodeId] ?? { kind: 'unreachable' };
        },
      }),
      signal: new AbortController().signal,
      concurrency: 1,
      skip: () => false,
      onActive: (item, state) => seen.push([item.id, state.state]),
    });
    expect(seen).toEqual([
      ['dl', 'downloading'],
      ['exec', 'executing'],
    ]);
    expect(polled).toEqual(['dl', 'exec', 'idle', 'stopped', 'broken', 'down']);
  });

  test('本会话已有升级在跑的行跳过，连查询都不发', async () => {
    const polled: string[] = [];
    await restoreUpgradeStates({
      rows: [row({ id: 'dl' }), row({ id: 'exec' })],
      io: stubIo({
        poll: async (nodeId) => {
          polled.push(nodeId);
          return SCRIPT[nodeId] ?? { kind: 'unreachable' };
        },
      }),
      signal: new AbortController().signal,
      concurrency: 1,
      skip: (nodeId) => nodeId === 'dl',
      onActive: () => undefined,
    });
    expect(polled).toEqual(['exec']);
  });

  test('查询并发上限为 3', async () => {
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => row({ id }));
    const done = restoreUpgradeStates({
      rows,
      io: stubIo({
        poll: (nodeId) => {
          started.push(nodeId);
          return new Promise<UpgradePollOutcome>((resolve) => {
            release.set(nodeId, () => resolve({ kind: 'status', status: status() }));
          });
        },
      }),
      signal: new AbortController().signal,
      skip: () => false,
      onActive: () => undefined,
    });

    await flush();
    expect(RESTORE_CONCURRENCY).toBe(3);
    expect(started).toEqual(['a', 'b', 'c']);

    release.get('b')?.();
    await flush();
    expect(started).toEqual(['a', 'b', 'c', 'd']);

    for (const id of ['a', 'c', 'd', 'e']) {
      release.get(id)?.();
      await flush();
    }
    await done;
    expect(started).toHaveLength(5);
  });

  test('signal 已 abort：一次都不查', async () => {
    const polled: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await restoreUpgradeStates({
      rows: [row({ id: 'dl' })],
      io: stubIo({
        poll: async (nodeId) => {
          polled.push(nodeId);
          return SCRIPT.dl as UpgradePollOutcome;
        },
      }),
      signal: controller.signal,
      skip: () => false,
      onActive: () => undefined,
    });
    expect(polled).toEqual([]);
  });
});

describe('cancelNodeUpgrade', () => {
  function run(outcome: UpgradeCancelOutcome, overrides: Partial<UpgradeCancelParams> = {}) {
    const rec = recorder();
    const patches: Array<Record<string, unknown>> = [];
    const counts = { stopped: 0, changed: 0 };
    const result = cancelNodeUpgrade({
      row: { id: 'n1', name: 'studio' },
      io: stubIo({ cancel: async () => outcome }),
      signal: new AbortController().signal,
      t,
      toasts: rec.toasts,
      patch: (entry) => patches.push(entry as Record<string, unknown>),
      stopWatch: () => {
        counts.stopped += 1;
      },
      onChanged: () => {
        counts.changed += 1;
      },
      ...overrides,
    });
    return { rec, patches, counts, result };
  }

  test('200：先掐掉轮询，再回到静止态并给一条 info，最后刷新列表', async () => {
    const done = run({ kind: 'cancelled', status: status({ error: 'UPGRADE_CANCELLED' }) });
    expect(await done.result).toBe('cancelled');
    expect(done.counts).toEqual({ stopped: 1, changed: 1 });
    expect(done.patches).toEqual([{ phase: 'idle', targetVersion: null, error: null }]);
    expect(done.rec.log).toEqual([['info', 'nodes.upgrade.cancelled:{"name":"studio"}']]);
  });

  test('409 UPGRADE_NOT_CANCELLABLE：只提示「正在安装」，轮询继续', async () => {
    const done = run({ kind: 'failed', code: 'UPGRADE_NOT_CANCELLABLE', httpStatus: 409 });
    expect(await done.result).toBe('rejected');
    expect(done.counts).toEqual({ stopped: 0, changed: 0 });
    expect(done.patches).toEqual([]);
    expect(done.rec.log).toEqual([['warning', 'nodes.upgrade.cancelNotAllowed']]);
  });

  test('501 UPGRADE_CANCEL_UNSUPPORTED：提示该节点版本不支持中断', async () => {
    const done = run({ kind: 'failed', code: 'UPGRADE_CANCEL_UNSUPPORTED', httpStatus: 501 });
    expect(await done.result).toBe('rejected');
    expect(done.rec.log).toEqual([['warning', 'nodes.upgrade.cancelUnsupported']]);
  });

  test('409 UPGRADE_NOT_RUNNING：良性结论，给 info 不给报错', async () => {
    const done = run({ kind: 'failed', code: 'UPGRADE_NOT_RUNNING', httpStatus: 409 });
    expect(await done.result).toBe('rejected');
    expect(done.rec.log).toEqual([['info', 'nodes.upgrade.cancelNotRunning']]);
  });

  test('DELETE 扑空但 POST 还在途：改成等 POST 落地再补一次，不提示', async () => {
    const done = run(
      { kind: 'failed', code: 'UPGRADE_NOT_RUNNING', httpStatus: 409 },
      {
        retry: () => true,
      }
    );
    expect(await done.result).toBe('deferred');
    expect(done.rec.log).toEqual([]);
    expect(done.counts).toEqual({ stopped: 0, changed: 0 });
  });

  test('旧入口 / 旧目标：404 / 405 / 501 一律按「不支持中断」提示，轮询继续', async () => {
    for (const [httpStatus, code] of [
      [404, 'NOT_FOUND'],
      [405, 'method_not_allowed'],
      [501, 'UPGRADE_FAILED'],
    ] as const) {
      const done = run({ kind: 'failed', code, httpStatus });
      expect(await done.result).toBe('rejected');
      expect(done.rec.log).toEqual([['warning', 'nodes.upgrade.cancelUnsupported']]);
      expect(done.counts).toEqual({ stopped: 0, changed: 0 });
    }
  });

  test('其余错误走错误表，轮询照常继续', async () => {
    const done = run({ kind: 'failed', code: 'NODE_UNREACHABLE', httpStatus: 502 });
    expect(await done.result).toBe('rejected');
    expect(done.counts).toEqual({ stopped: 0, changed: 0 });
    expect(done.rec.log).toEqual([
      ['error', 'nodes.upgrade.cancelFailed:{"error":"nodes.upgrade.unreachable"}'],
    ]);
  });
});

describe('createNodeAbortRegistry', () => {
  test('停一行不影响别的行；卸载时一把全停', () => {
    const registry = createNodeAbortRegistry();
    const a = registry.open('a');
    const b = registry.open('b');
    registry.stop('a');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    // 已经停掉的行再停一次不会波及别人
    registry.stop('a');
    expect(b.signal.aborted).toBe(false);
    registry.stopAll();
    expect(b.signal.aborted).toBe(true);
  });

  test('release 只摘掉自己那把，不会误停后一次升级新开的 controller', () => {
    const registry = createNodeAbortRegistry();
    const first = registry.open('a');
    const second = registry.open('a');
    registry.release('a', first);
    registry.stop('a');
    expect(second.signal.aborted).toBe(true);
  });
});

describe('createUpgradeCancelGate', () => {
  test('POST 不在途时立刻发 DELETE；同一行不重复发', () => {
    const gate = createUpgradeCancelGate();
    expect(gate.request('a')).toBe('send');
    expect(gate.cancelling('a')).toBe(true);
    expect(gate.request('a')).toBe('busy');
    gate.finish('a');
    expect(gate.cancelling('a')).toBe(false);
    expect(gate.request('a')).toBe('send');
  });

  test('POST 在途时先记账，等 POST 落地再补发一次', () => {
    const gate = createUpgradeCancelGate();
    gate.beginStart('a');
    expect(gate.request('a')).toBe('defer');
    expect(gate.pending('a')).toBe(true);
    // 连点只记一次
    expect(gate.request('a')).toBe('busy');
    expect(gate.endStart('a')).toBe(true);
    expect(gate.endStart('a')).toBe(false);
  });

  test('没按过停止：POST 落地不补发；DELETE 扑空时才改排队', () => {
    const gate = createUpgradeCancelGate();
    gate.beginStart('a');
    expect(gate.pending('a')).toBe(false);
    expect(gate.endStart('a')).toBe(false);
    // POST 已经落地：没有可等的东西，不排队
    expect(gate.deferIfStarting('a')).toBe(false);
    gate.beginStart('b');
    expect(gate.deferIfStarting('b')).toBe(true);
    expect(gate.endStart('b')).toBe(true);
  });

  test('finish 把排队的那一次也清掉', () => {
    const gate = createUpgradeCancelGate();
    gate.beginStart('a');
    gate.request('a');
    gate.finish('a');
    expect(gate.cancelling('a')).toBe(false);
    expect(gate.endStart('a')).toBe(false);
  });
});

describe('POST 在途时按下「停止升级」', () => {
  const TARGET = { id: 'n1', name: 'studio' };

  /** 复刻 hook 的接线：`UpgradeCancelGate` + `cancelNodeUpgrade` + `runNodeUpgrade` 的 handoff。 */
  function wire(opts: { start: Promise<UpgradeStartOutcome>; cancel?: UpgradeCancelOutcome }) {
    const rec = recorder();
    const gate = createUpgradeCancelGate();
    const controller = new AbortController();
    const entry: NodeUpgradeEntry = {
      phase: 'idle',
      targetVersion: null,
      error: null,
      cancelling: false,
    };
    const cancels: string[] = [];
    const io = stubIo({
      start: () => opts.start,
      cancel: async (nodeId) => {
        cancels.push(nodeId);
        return opts.cancel ?? { kind: 'cancelled', status: status({ error: 'UPGRADE_CANCELLED' }) };
      },
      poll: async () => ({ kind: 'failed', code: 'NOT_FOUND' }),
    });
    const patch = (next: Partial<NodeUpgradeEntry>) => Object.assign(entry, next);
    const runCancel = () =>
      cancelNodeUpgrade({
        row: TARGET,
        io,
        signal: controller.signal,
        t,
        toasts: rec.toasts,
        patch,
        stopWatch: () => controller.abort(),
        onChanged: () => undefined,
        retry: () => gate.deferIfStarting(TARGET.id),
      }).then((result) => {
        if (result !== 'deferred') {
          gate.finish(TARGET.id);
          patch({ cancelling: false });
        }
        return result;
      });
    const run = runNodeUpgrade({
      row: TARGET,
      targetVersion: '1.2.0',
      io,
      signal: controller.signal,
      t,
      toasts: rec.toasts,
      patch,
      onChanged: () => undefined,
      handoff: {
        begin: () => gate.beginStart(TARGET.id),
        pending: () => gate.pending(TARGET.id),
        settle: async (live) => {
          if (!gate.endStart(TARGET.id)) return 'none';
          if (!live) {
            gate.finish(TARGET.id);
            patch({ cancelling: false });
            return 'none';
          }
          return (await runCancel()) === 'cancelled' ? 'cancelled' : 'rejected';
        },
      },
    });
    /** 用户按下停止按钮。 */
    const press = () => {
      const mode = gate.request(TARGET.id);
      if (mode === 'busy') return mode;
      patch({ cancelling: true });
      if (mode === 'send') void runCancel();
      return mode;
    };
    return { rec, gate, entry, cancels, run, press };
  }

  test('POST 在途时按停止：先记账不发 DELETE，POST 落地后只补发一次，行回到静止态', async () => {
    let resolveStart!: (value: UpgradeStartOutcome) => void;
    const start = new Promise<UpgradeStartOutcome>((resolve) => {
      resolveStart = resolve;
    });
    const w = wire({ start });
    await flush();

    expect(w.entry.phase).toBe('pending');
    expect(w.press()).toBe('defer');
    // 连点两下也只排一次
    expect(w.press()).toBe('busy');
    expect(w.cancels).toEqual([]);
    expect(w.entry.cancelling).toBe(true);

    resolveStart({
      kind: 'started',
      status: status({ state: 'downloading', targetVersion: '1.2.0' }),
    });
    expect(await w.run).toBe('cancelled');
    expect(w.cancels).toEqual(['n1']);
    expect(w.entry).toEqual({
      phase: 'idle',
      targetVersion: null,
      error: null,
      push: null,
      cancelling: false,
    });
    // 「已开始升级」不再弹：用户按下停止之后再报开始只会添乱
    expect(w.rec.log).toEqual([['info', 'nodes.upgrade.cancelled:{"name":"studio"}']]);
    expect(w.gate.cancelling('n1')).toBe(false);
  });

  test('POST 落地就是失败：不补发 DELETE，取消记账一并清掉', async () => {
    let resolveStart!: (value: UpgradeStartOutcome) => void;
    const start = new Promise<UpgradeStartOutcome>((resolve) => {
      resolveStart = resolve;
    });
    const w = wire({ start });
    await flush();
    w.press();

    resolveStart({ kind: 'failed', code: 'UPGRADE_NOT_ALLOWED' });
    expect(await w.run).toBe('failed');
    expect(w.cancels).toEqual([]);
    expect(w.entry.cancelling).toBe(false);
    expect(w.gate.cancelling('n1')).toBe(false);
    expect(w.rec.log).toEqual([
      ['error', 'nodes.upgrade.failed:{"error":"nodes.upgrade.notAllowed"}'],
    ]);
  });

  test('补发的 DELETE 被拒（正在安装）：轮询继续，不会谎报已取消', async () => {
    let resolveStart!: (value: UpgradeStartOutcome) => void;
    const start = new Promise<UpgradeStartOutcome>((resolve) => {
      resolveStart = resolve;
    });
    const w = wire({
      start,
      cancel: { kind: 'failed', code: 'UPGRADE_NOT_CANCELLABLE', httpStatus: 409 },
    });
    await flush();
    w.press();

    resolveStart({
      kind: 'started',
      status: status({ state: 'downloading', targetVersion: '1.2.0' }),
    });
    // 停止被拒后接着盯：这一轮 poll 报节点已不在网络中，按失败收尾
    expect(await w.run).toBe('failed');
    expect(w.cancels).toEqual(['n1']);
    expect(w.rec.log).toEqual([
      ['warning', 'nodes.upgrade.cancelNotAllowed'],
      ['error', 'nodes.upgrade.failed:{"error":"nodes.upgrade.nodeGone"}'],
    ]);
    expect(w.entry.cancelling).toBe(false);
  });
});

describe('推包进度与预算', () => {
  /** 假 IO：wait 推进时钟，poll 按脚本逐次给结果（越界用最后一项）。 */
  function progressIo(polls: UpgradePollOutcome[]): UpgradeIo & { clock: () => number } {
    let clock = 0;
    let index = 0;
    const io = stubIo({
      poll: async () => polls[Math.min(index++, polls.length - 1)] as UpgradePollOutcome,
      nodeVersion: async () => '1.2.0',
      wait: async (ms) => {
        clock += ms;
        return true;
      },
      now: () => clock,
    });
    return { ...io, clock: () => clock };
  }

  function pushing(pushedBytes: number): UpgradePollOutcome {
    return {
      kind: 'status',
      status: status({
        state: 'downloading',
        targetVersion: '1.2.0',
        progress: { phase: 'push', pushedBytes, totalBytes: 13_500_000, attempt: 1 },
      }),
    };
  }

  test('推包字节一直在涨：预算跟着重新计时，不会在六分钟处判超时', async () => {
    // 6 分钟 = 180 轮（2 s 一轮）；这里排 300 轮持续推进，再回到 idle 收尾。
    const polls: UpgradePollOutcome[] = [];
    for (let i = 1; i <= 300; i += 1) polls.push(pushing(i * 40_000));
    polls.push({ kind: 'status', status: status({ state: 'idle' }) });
    const io = progressIo(polls);
    const pushes: Array<{ pushedBytes: number; totalBytes: number } | null | undefined> = [];
    const result = await watchUpgrade({
      nodeId: 'n1',
      targetVersion: '1.2.0',
      sawActive: true,
      unconfirmedStart: false,
      io,
      signal: new AbortController().signal,
      describeError: (code) => code,
      phase: () => undefined,
      progress: (push) => pushes.push(push),
    });
    expect(result).toEqual({ kind: 'done' });
    expect(io.clock()).toBeGreaterThan(6 * 60_000);
    // 300 轮推包各报一次，最后回到 idle 时再清一次，免得表格上留着过期进度。
    expect(pushes).toHaveLength(301);
    expect(pushes.at(-2)).toEqual({ pushedBytes: 300 * 40_000, totalBytes: 13_500_000 });
    expect(pushes.at(-1)).toBeNull();
  });

  test('进度停在原地：预算照常到期，报「未确认」而不是无限等', async () => {
    const io = progressIo([pushing(40_000)]);
    const result = await watchUpgrade({
      nodeId: 'n1',
      targetVersion: '1.2.0',
      sawActive: true,
      unconfirmedStart: false,
      io,
      signal: new AbortController().signal,
      describeError: (code) => code,
      phase: () => undefined,
    });
    expect(result).toEqual({ kind: 'timeout' });
    expect(io.clock()).toBeLessThanOrEqual(6 * 60_000 + 2_000);
  });

  test('下载阶段的进度不当推包展示：总量未知时不摆进度', () => {
    expect(pushProgressOf(null)).toBeNull();
    expect(
      pushProgressOf({ phase: 'download', pushedBytes: 0, totalBytes: 0, attempt: 0 })
    ).toBeNull();
    expect(
      pushProgressOf({ phase: 'push', pushedBytes: 10, totalBytes: 0, attempt: 1 })
    ).toBeNull();
    expect(pushProgressOf({ phase: 'push', pushedBytes: 10, totalBytes: 20, attempt: 2 })).toEqual({
      pushedBytes: 10,
      totalBytes: 20,
    });
  });

  test('推包阶段的按钮文案带上「已传 / 总量」', () => {
    expect(upgradePhaseText(t, 'downloading')).toBe('nodes.upgrade.stateDownloading');
    expect(upgradePhaseText(t, 'downloading', { pushedBytes: 1024, totalBytes: 2048 })).toBe(
      'nodes.upgrade.statePushing:{"progress":"1.00 KB / 2.00 KB"}'
    );
  });

  test('后端原始失败串翻成人话，认不出的保持原样', () => {
    expect(upgradeErrorText(t, 'push failed: HTTP 503 NODE_UNREACHABLE link_lost')).toBe(
      'nodes.upgrade.linkLost'
    );
    expect(upgradeErrorText(t, 'push failed: push timeout')).toBe('nodes.upgrade.pushTimeout');
    expect(upgradeErrorText(t, 'push failed: HTTP 500 PACKAGE_INCOMPLETE')).toBe(
      'nodes.upgrade.pushFailed'
    );
    expect(upgradeErrorText(t, 'UPGRADE_OFFSET_MISMATCH')).toBe('nodes.upgrade.pushFailed');
    expect(upgradeErrorText(t, 'download failed: GitHub release tarball HTTP 403')).toBe(
      'nodes.upgrade.downloadFailed'
    );
    expect(upgradeErrorText(t, 'start failed: HTTP 409 UPGRADE_IN_PROGRESS')).toBe(
      'nodes.upgrade.startFailed'
    );
    expect(upgradeErrorText(t, 'BOOM')).toBe('BOOM');
  });
});

describe('createSemaphore', () => {
  test('多轮回读共用一把信号量：总并发始终不超过上限', async () => {
    const gate = createSemaphore(RESTORE_CONCURRENCY);
    const release = new Map<string, () => void>();
    let active = 0;
    let peak = 0;
    const io = stubIo({
      poll: (nodeId) => {
        active += 1;
        peak = Math.max(peak, active);
        return new Promise<UpgradePollOutcome>((resolve) => {
          release.set(nodeId, () => {
            active -= 1;
            resolve({ kind: 'status', status: status() });
          });
        });
      },
    });
    const shared = {
      io,
      gate,
      signal: new AbortController().signal,
      skip: () => false,
      onActive: () => undefined,
    };
    const first = restoreUpgradeStates({
      ...shared,
      rows: ['a', 'b', 'c', 'd'].map((id) => row({ id })),
    });
    await flush();
    // 第一轮的三个 GET 还没回来，列表又多了三台机器
    const second = restoreUpgradeStates({
      ...shared,
      rows: ['e', 'f', 'g'].map((id) => row({ id })),
    });
    await flush();
    expect(peak).toBe(RESTORE_CONCURRENCY);

    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      release.get(id)?.();
      await flush();
    }
    await Promise.all([first, second]);
    expect(release.size).toBe(7);
    expect(peak).toBe(RESTORE_CONCURRENCY);
  });
});

describe('restoreUpgradeStates 的回读收尾', () => {
  test('每一行都收尾一次，跳过的行也不例外', async () => {
    const settled: string[] = [];
    await restoreUpgradeStates({
      rows: [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'offline', online: false })],
      io: stubIo({ poll: async () => ({ kind: 'status', status: status() }) }),
      signal: new AbortController().signal,
      concurrency: 1,
      skip: (nodeId) => nodeId === 'b',
      onSettled: (nodeId) => settled.push(nodeId),
      onActive: () => undefined,
    });
    expect(settled).toEqual(['a', 'b']);
  });
});

describe('retainKnownIds', () => {
  test('节点离开列表就忘掉它：同一个 id 再出现时要重新回读', () => {
    const seen = new Set(['a', 'b']);
    retainKnownIds(seen, [row({ id: 'a' })]);
    expect([...seen]).toEqual(['a']);
    // 只是离线 / 掉登录的行仍在列表里，不重复回读
    retainKnownIds(seen, [row({ id: 'a', online: false })]);
    expect([...seen]).toEqual(['a']);
  });
});

describe('createResumeQueue', () => {
  test('这一行空着就直接接手', () => {
    const seen: string[] = [];
    const queue = createResumeQueue({ busy: () => false, resume: (item) => seen.push(item.id) });
    expect(queue.offer(row({ id: 'a' }), status({ state: 'downloading' }))).toBe(true);
    expect(seen).toEqual(['a']);
  });

  test('行内升级正占着这一行：排队等它让开，绝不把回读到的在途升级丢掉', () => {
    const busy = new Set(['a']);
    const seen: string[] = [];
    const queue = createResumeQueue({
      busy: (nodeId) => busy.has(nodeId),
      resume: (item) => seen.push(item.id),
    });
    expect(queue.offer(row({ id: 'a' }), status({ state: 'downloading' }))).toBe(false);
    expect(seen).toEqual([]);
    busy.delete('a');
    queue.release('a', 'failed');
    expect(seen).toEqual(['a']);
    // 只接手一次
    queue.release('a', 'failed');
    expect(seen).toEqual(['a']);
  });

  test('这一行刚自己升成功：排队的接手作废，回读到的状态已经过时', () => {
    const seen: string[] = [];
    const queue = createResumeQueue({ busy: () => true, resume: (item) => seen.push(item.id) });
    queue.offer(row({ id: 'a' }), status({ state: 'downloading' }));
    queue.release('a', 'done');
    expect(seen).toEqual([]);
    queue.release('a', 'failed');
    expect(seen).toEqual([]);
  });
});

describe('launchUpgradeBatch', () => {
  const rows = [
    row({ id: 'self', name: 'self', isSelf: true, version: '1.1.9' }),
    row({ id: 'hub', name: 'hub', isHub: true, version: '1.1.9' }),
    row({ id: 'a', name: 'a', version: '1.1.9' }),
    row({ id: 'latest', name: 'latest', version: '1.2.0' }),
    row({ id: 'old', name: 'old', version: '1.0.0' }),
  ];

  function launch(overrides: Partial<Parameters<typeof launchUpgradeBatch>[0]> = {}) {
    const rec = recorder();
    const controller = new AbortController();
    const confirms: string[] = [];
    const seen: Array<{ name: string; toasts: UpgradeToasts }> = [];
    const starts: number[] = [];
    const running = launchUpgradeBatch({
      rows,
      latestVersion: '1.2.0',
      rowRunning: false,
      restoring: false,
      signal: controller.signal,
      t,
      toasts: rec.toasts,
      confirm: (message) => {
        confirms.push(message);
        return true;
      },
      runOne: async (node, _version, toasts) => {
        seen.push({ name: node.name, toasts });
        return 'done';
      },
      onStart: (total) => starts.push(total),
      onProgress: () => undefined,
      ...overrides,
    });
    return { rec, controller, confirms, seen, starts, running };
  }

  test('一次确认列出候选数与目标版本，已最新与过旧的节点被排除', async () => {
    const run = launch();
    expect(run.confirms).toHaveLength(1);
    expect(run.confirms[0]).toBe('nodes.upgrade.confirmAll:{"count":3,"version":"1.2.0"}');
    expect(run.starts).toEqual([3]);
    await run.running;
    expect(run.seen.map((item) => item.name)).toEqual(['a', 'hub', 'self']);
  });

  test('批量期间每节点 toast 被静音，只留最后那条汇总', async () => {
    const run = launch();
    await run.running;
    expect(run.seen.every((item) => item.toasts === SILENT_UPGRADE_TOASTS)).toBe(true);
    expect(run.rec.log).toEqual([['success', 'nodes.upgrade.allDone:{"success":3,"failed":0}']]);
  });

  test('用户取消确认框：不启动，也不提示', () => {
    const run = launch({ confirm: () => false });
    expect(run.running).toBeNull();
    expect(run.starts).toEqual([]);
    expect(run.rec.log).toEqual([]);
  });

  test('latest 未知或没有候选：直接返回 null，不弹确认框', () => {
    expect(launch({ latestVersion: null }).running).toBeNull();
    const none = launch({ rows: [row({ id: 'latest', name: 'latest', version: '1.2.0' })] });
    expect(none.running).toBeNull();
    expect(none.confirms).toEqual([]);
  });

  test('已有行内升级在跑：不启动、不弹确认框，只给一条 info', () => {
    const run = launch({ rowRunning: true });
    expect(run.running).toBeNull();
    expect(run.confirms).toEqual([]);
    expect(run.starts).toEqual([]);
    expect(run.seen).toEqual([]);
    expect(run.rec.log).toEqual([['info', 'nodes.upgrade.allBusy']]);
  });

  test('还在回读升级状态：整批让路，只给一条 info', () => {
    const run = launch({ restoring: true });
    expect(run.running).toBeNull();
    expect(run.confirms).toEqual([]);
    expect(run.starts).toEqual([]);
    expect(run.seen).toEqual([]);
    expect(run.rec.log).toEqual([['info', 'nodes.upgrade.restoring']]);
  });
});

describe('launchRowUpgrade', () => {
  function launch(overrides: Partial<Parameters<typeof launchRowUpgrade>[0]> = {}) {
    const confirms: string[] = [];
    const seen: string[] = [];
    const started = launchRowUpgrade({
      row: row({ id: 'hub', name: 'hub', isHub: true, version: '1.1.9' }),
      latestVersion: '1.2.0',
      batchRunning: false,
      nodeRunning: false,
      restoring: false,
      t,
      confirm: (message) => {
        confirms.push(message);
        return true;
      },
      runOne: async (node) => {
        seen.push(node.name);
        return 'done';
      },
      ...overrides,
    });
    return { confirms, seen, started };
  }

  test('正常路径：确认后跑起来', async () => {
    const run = launch();
    expect(run.confirms).toHaveLength(1);
    expect(run.confirms[0]).toContain('nodes.upgrade.confirmRemote');
    expect(await run.started).toBe('done');
    expect(run.seen).toEqual(['hub']);
  });

  test('批量正在推进：行内升级不受理，连确认框都不弹', () => {
    const run = launch({ batchRunning: true });
    expect(run.started).toBeNull();
    expect(run.confirms).toEqual([]);
    expect(run.seen).toEqual([]);
  });

  test('同一节点已有升级在跑：不重复触发', () => {
    const run = launch({ nodeRunning: true });
    expect(run.started).toBeNull();
    expect(run.confirms).toEqual([]);
  });

  test('这一行正在回读升级状态：先不受理，免得与回读到的在途升级抢同一台机器', () => {
    const run = launch({ restoring: true });
    expect(run.started).toBeNull();
    expect(run.confirms).toEqual([]);
    expect(run.seen).toEqual([]);
  });

  test('用户取消确认框：不跑', () => {
    const run = launch({ confirm: () => false });
    expect(run.started).toBeNull();
    expect(run.seen).toEqual([]);
  });
});

describe('runUpgradeBatch 的续跑入参', () => {
  const rows = ['a', 'b', 'c'].map((name) => row({ id: name, name }));

  test('给了 groups 就按它推进，不再按 orderUpgradeGroups 重排', async () => {
    const started: string[] = [];
    await runUpgradeBatch({
      rows,
      groups: [[rows[1] as NodeRow], [rows[0] as NodeRow, rows[2] as NodeRow]],
      signal: new AbortController().signal,
      run: async (node) => {
        started.push(node.name);
        return 'done';
      },
      onProgress: () => undefined,
    });
    expect(started).toEqual(['b', 'a', 'c']);
  });

  test('settled 里的既有结论直接进汇总与进度', async () => {
    const progress: number[] = [];
    const summary = await runUpgradeBatch({
      rows: [rows[0] as NodeRow],
      signal: new AbortController().signal,
      settled: [
        { name: 'old-ok', outcome: 'done' },
        { name: 'old-bad', outcome: 'timeout' },
      ],
      run: async () => 'done',
      onProgress: (completed) => progress.push(completed),
    });
    expect(summary).toEqual({
      succeeded: 2,
      failed: 1,
      failedNames: ['old-bad'],
      cancelledCount: 0,
      cancelled: false,
    });
    expect(progress).toEqual([3]);
  });

  test('onSettled 每台机器报一次结论', async () => {
    const settled: Array<[string, UpgradeRunOutcome]> = [];
    await runUpgradeBatch({
      rows,
      signal: new AbortController().signal,
      concurrency: 1,
      run: async (node) => (node.name === 'b' ? 'failed' : 'done'),
      onSettled: (node, outcome) => settled.push([node.id, outcome]),
      onProgress: () => undefined,
    });
    expect(settled).toEqual([
      ['a', 'done'],
      ['b', 'failed'],
      ['c', 'done'],
    ]);
  });
});

describe('批量计划的落盘与续跑', () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    for (const key of ['localStorage', 'sessionStorage'] as const) {
      if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value: createMemoryStorage(),
        configurable: true,
        writable: true,
      });
    }
  });

  afterEach(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    saved.clear();
  });

  const NOW = 1000;

  function sinkFor(order: string[][], targetVersion: string, done: UpgradeBatchPlan['done'] = []) {
    const plan: UpgradeBatchPlan = {
      ...createBatchPlan({
        entryNodeId: 'self',
        targetVersion,
        order,
        now: NOW,
        tabId: 'tab-1',
      }),
      done,
    };
    return { plan, sink: createBatchPlanSink(plan, () => NOW) };
  }

  test('别的标签页还握着这批：`startAll` 前的互斥判定拦下，心跳停摆后才放行', () => {
    saveBatchPlan(
      createBatchPlan({
        entryNodeId: 'self',
        targetVersion: '1.1.13',
        order: [['a'], ['self']],
        now: NOW,
        tabId: 'tab-other',
      })
    );
    expect(batchOwnedByOtherTab('self', 'tab-mine', NOW)).toBe(true);
    expect(batchOwnedByOtherTab('self', 'tab-other', NOW)).toBe(false);
    expect(batchOwnedByOtherTab('self', 'tab-mine', NOW + UPGRADE_BATCH_OWNER_STALE_MS + 1)).toBe(
      false
    );
  });

  test('批量开跑即落盘（分组顺序 + 目标版本），汇总弹完才清掉', async () => {
    const rec = recorder();
    const opened: Array<{ order: string[][]; version: string }> = [];
    const running = launchUpgradeBatch({
      rows: [
        row({ id: 'self', name: 'self', isSelf: true, version: '1.1.9' }),
        row({ id: 'hub', name: 'hub', isHub: true, version: '1.1.9' }),
        row({ id: 'a', name: 'a', version: '1.1.9' }),
      ],
      latestVersion: '1.2.0',
      rowRunning: false,
      restoring: false,
      signal: new AbortController().signal,
      t,
      toasts: rec.toasts,
      confirm: () => true,
      runOne: async () => 'done',
      onStart: () => undefined,
      onProgress: () => undefined,
      openPlan: (order, version) => {
        opened.push({ order, version });
        return sinkFor(order, version).sink;
      },
    });
    expect(opened).toEqual([{ order: [['a'], ['hub'], ['self']], version: '1.2.0' }]);
    expect(loadBatchPlan('self', NOW)).not.toBeNull();

    await running;
    expect(rec.log).toEqual([['success', 'nodes.upgrade.allDone:{"success":3,"failed":0}']]);
    expect(loadBatchPlan('self', NOW)).toBeNull();
  });

  test('每台机器落定都写进计划；卸载打断时计划原样留着', async () => {
    const rec = recorder();
    const controller = new AbortController();
    let sink = sinkFor([['a']], '1.2.0').sink;
    const running = launchUpgradeBatch({
      rows: [
        row({ id: 'a', name: 'a', version: '1.1.9' }),
        row({ id: 'hub', name: 'hub', isHub: true, version: '1.1.9' }),
      ],
      latestVersion: '1.2.0',
      rowRunning: false,
      restoring: false,
      signal: controller.signal,
      t,
      toasts: rec.toasts,
      confirm: () => true,
      runOne: async () => {
        // 页面在第一台机器跑完时被关掉
        controller.abort();
        return 'done';
      },
      onStart: () => undefined,
      onProgress: () => undefined,
      openPlan: (order, version) => {
        sink = sinkFor(order, version).sink;
        return sink;
      },
    });
    await running;
    // 结论不完整：不弹汇总，计划留给下次挂载续跑
    expect(rec.log).toEqual([]);
    expect(sink.plan().done).toEqual([{ nodeId: 'a', outcome: 'done' }]);
    expect(loadBatchPlan('self', NOW)?.done).toEqual([{ nodeId: 'a', outcome: 'done' }]);
  });

  test('刷新后续跑：在途的等结论，没开始的按组接着跑，只弹一条汇总并清掉计划', async () => {
    const rows = [
      row({ id: 'a', name: 'a', version: '1.1.9' }),
      row({ id: 'b', name: 'b', version: '1.1.9' }),
      row({ id: 'c', name: 'c', version: '1.1.9' }),
      row({ id: 'hub', name: 'hub', isHub: true, version: '1.1.9' }),
      row({ id: 'self', name: 'self', isSelf: true, version: '1.1.9' }),
    ];
    const { plan, sink } = sinkFor([['a', 'b', 'c'], ['hub'], ['self']], '1.2.0', [
      { nodeId: 'a', outcome: 'done' },
    ]);
    const rec = recorder();
    const posted: string[] = [];
    const release = new Map<string, (outcome: UpgradeRunOutcome) => void>();
    const starts: Array<[number, number]> = [];
    const progress: number[] = [];
    // b 的升级已经被刷新回读接管：只等它的结论，绝不重发 POST
    const joined = new Promise<UpgradeRunOutcome>((resolve) => release.set('b', resolve));
    const done = resumeUpgradeBatch({
      plan,
      rows,
      signal: new AbortController().signal,
      t,
      toasts: rec.toasts,
      sink,
      joinRunning: (node) => (node.id === 'b' ? joined : null),
      runOne: (node, version, toasts) => {
        expect(version).toBe('1.2.0');
        expect(toasts).toBe(SILENT_UPGRADE_TOASTS);
        posted.push(node.name);
        return new Promise<UpgradeRunOutcome>((resolve) => release.set(node.id, resolve));
      },
      onStart: (total, completed) => starts.push([total, completed]),
      onProgress: (completed) => progress.push(completed),
    });

    await flush();
    // 上一次已经跑完的 a 不再重发；同组的 c 立刻补上，hub / self 仍要等这一组收尾
    expect(starts).toEqual([[5, 1]]);
    expect(posted).toEqual(['c']);
    expect(rec.log).toEqual([['info', 'nodes.upgrade.allResumed']]);

    release.get('c')?.('done');
    await flush();
    expect(posted).toEqual(['c']);

    release.get('b')?.('done');
    await flush();
    expect(posted).toEqual(['c', 'hub']);

    release.get('hub')?.('done');
    await flush();
    expect(posted).toEqual(['c', 'hub', 'self']);

    release.get('self')?.('done');
    const summary = await done;
    expect(summary).toEqual({
      succeeded: 5,
      failed: 0,
      failedNames: [],
      cancelledCount: 0,
      cancelled: false,
    });
    expect(progress).toEqual([2, 3, 4, 5]);
    expect(rec.log).toEqual([
      ['info', 'nodes.upgrade.allResumed'],
      ['success', 'nodes.upgrade.allDone:{"success":5,"failed":0}'],
    ]);
    // 落定顺序即写入顺序：c 先于 b 收尾
    expect(sink.plan().done.map((item) => item.nodeId)).toEqual(['a', 'c', 'b', 'hub', 'self']);
    expect(loadBatchPlan('self', NOW)).toBeNull();
  });

  test('本机在刷新前就升完了：不再发 POST，按已是最新计成功', async () => {
    const { plan, sink } = sinkFor([['hub'], ['self']], '1.2.0', [
      { nodeId: 'hub', outcome: 'done' },
    ]);
    const rec = recorder();
    const posted: string[] = [];
    const summary = await resumeUpgradeBatch({
      plan,
      rows: [
        row({ id: 'hub', name: 'hub', isHub: true, version: '1.2.0' }),
        // 本机重启回来，版本已经对上：这次批量对它已经收尾
        row({ id: 'self', name: 'self', isSelf: true, version: '1.2.0' }),
      ],
      signal: new AbortController().signal,
      t,
      toasts: rec.toasts,
      sink,
      joinRunning: () => null,
      runOne: async (node) => {
        posted.push(node.name);
        return 'done';
      },
      onStart: () => undefined,
      onProgress: () => undefined,
    });
    expect(posted).toEqual([]);
    expect(summary.succeeded).toBe(2);
    expect(rec.log).toEqual([
      ['info', 'nodes.upgrade.allResumed'],
      ['success', 'nodes.upgrade.allDone:{"success":2,"failed":0}'],
    ]);
    expect(loadBatchPlan('self', NOW)).toBeNull();
  });

  test('计划里的机器一台都不在列表里：静默作废，不弹任何 toast', async () => {
    const { plan, sink } = sinkFor([['gone']], '1.2.0');
    const rec = recorder();
    const summary = await resumeUpgradeBatch({
      plan,
      rows: [row({ id: 'other', name: 'other', version: '1.2.0' })],
      signal: new AbortController().signal,
      t,
      toasts: rec.toasts,
      sink,
      joinRunning: () => null,
      runOne: async () => 'done',
      onStart: () => undefined,
      onProgress: () => undefined,
    });
    expect(summary.succeeded).toBe(0);
    expect(rec.log).toEqual([]);
    expect(loadBatchPlan('self', NOW)).toBeNull();
  });

  test('计划里的节点已经离开列表：不再计入，也不当失败报', async () => {
    const { plan, sink } = sinkFor([['gone'], ['self']], '1.2.0');
    const rec = recorder();
    const summary = await resumeUpgradeBatch({
      plan,
      rows: [row({ id: 'self', name: 'self', isSelf: true, version: '1.2.0' })],
      signal: new AbortController().signal,
      t,
      toasts: rec.toasts,
      sink,
      joinRunning: () => null,
      runOne: async () => 'done',
      onStart: () => undefined,
      onProgress: () => undefined,
    });
    expect(summary).toEqual({
      succeeded: 1,
      failed: 0,
      failedNames: [],
      cancelledCount: 0,
      cancelled: false,
    });
  });

  test('续跑期间用户按了停止：按已取消计入汇总，计划照常清掉', async () => {
    const { plan, sink } = sinkFor([['a']], '1.2.0', [{ nodeId: 'x', outcome: 'done' }]);
    const rec = recorder();
    const summary = await resumeUpgradeBatch({
      plan,
      rows: [row({ id: 'a', name: 'a', version: '1.1.9' }), row({ id: 'x', name: 'x' })],
      signal: new AbortController().signal,
      t,
      toasts: rec.toasts,
      sink,
      joinRunning: () => null,
      runOne: async () => 'cancelled',
      onStart: () => undefined,
      onProgress: () => undefined,
    });
    expect(summary.cancelledCount).toBe(1);
    expect(rec.log).toEqual([
      ['info', 'nodes.upgrade.allResumed'],
      ['info', 'nodes.upgrade.allDoneWithCancelled:{"success":1,"failed":0,"cancelled":1}'],
    ]);
    // 用户主动停的那台是确定结论，照常记账
    expect(sink.plan().done).toContainEqual({ nodeId: 'a', outcome: 'cancelled' });
    expect(loadBatchPlan('self', NOW)).toBeNull();
  });

  test('卸载打断的那台机器不记账：下次挂载还要接着盯它', async () => {
    const controller = new AbortController();
    const { plan, sink } = sinkFor([['a'], ['self']], '1.2.0');
    await resumeUpgradeBatch({
      plan,
      rows: [
        row({ id: 'a', name: 'a', version: '1.1.9' }),
        row({ id: 'self', name: 'self', isSelf: true, version: '1.1.9' }),
      ],
      signal: controller.signal,
      t,
      toasts: recorder().toasts,
      sink,
      joinRunning: () => null,
      runOne: async () => {
        // 页面被关掉：这一行的轮询跟着停，但目标机上的升级还在跑
        controller.abort();
        return 'cancelled';
      },
      onStart: () => undefined,
      onProgress: () => undefined,
    });
    expect(sink.plan().done).toEqual([]);
    expect(sink.plan().summaryEmitted).toBe(false);
    expect(loadBatchPlan('self', NOW)?.done).toEqual([]);
  });
});

/** 让已排好的 microtask 全部跑完（worker 池在 await 之间推进）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
