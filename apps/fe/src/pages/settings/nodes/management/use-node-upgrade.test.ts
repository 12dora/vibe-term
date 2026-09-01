// 批量升级：候选筛选、执行顺序（普通节点 → 远端 hub → 本机）、并发上限与汇总提示；
// 刷新后的状态恢复与「停止升级」也在这里，全部走注入的 `run` / `io`，不碰网络也不碰计时器。

import { describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import type { UpgradeStatus } from '@tmex/shared';
import type { UpgradeRunOutcome } from './types';
import {
  BATCH_CONCURRENCY,
  MIN_REMOTE_UPGRADE_VERSION,
  eligibleUpgradeRows,
  isAtLatest,
  isBatchEligible,
  isTooOldForRemoteUpgrade,
  orderUpgradeGroups,
  runUpgradeBatch,
  upgradeBlockReason,
} from './upgrade-batch';
import {
  RESTORE_CONCURRENCY,
  SILENT_UPGRADE_TOASTS,
  type UpgradeCancelOutcome,
  type UpgradeIo,
  type UpgradePollOutcome,
  type UpgradeToasts,
  cancelNodeUpgrade,
  createNodeAbortRegistry,
  launchRowUpgrade,
  launchUpgradeBatch,
  reportBatchSummary,
  restorableRows,
  restoreUpgradeStates,
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
  function run(outcome: UpgradeCancelOutcome) {
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

  test('用户取消确认框：不跑', () => {
    const run = launch({ confirm: () => false });
    expect(run.started).toBeNull();
    expect(run.seen).toEqual([]);
  });
});

/** 让已排好的 microtask 全部跑完（worker 池在 await 之间推进）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
