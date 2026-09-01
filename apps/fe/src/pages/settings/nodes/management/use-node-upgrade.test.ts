// 批量升级：候选筛选、执行顺序（普通节点 → 远端 hub → 本机）、并发上限与汇总提示。
// 全部走注入的 `run`，不碰网络也不碰计时器。

import { describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
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
  SILENT_UPGRADE_TOASTS,
  type UpgradeToasts,
  launchRowUpgrade,
  launchUpgradeBatch,
  reportBatchSummary,
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
    expect(summary).toEqual({ succeeded: 4, failed: 0, failedNames: [], cancelled: false });
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

  test('成败统计：done / alreadyLatest 计成功，failed / timeout 计失败，cancelled 两边都不算', async () => {
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
      cancelled: false,
    });
    expect(rec.log).toHaveLength(1);
    expect(rec.log[0]?.[0]).toBe('warning');
    expect(rec.log[0]?.[1]).toContain('nodes.upgrade.allDoneWithFailures');
    expect(rec.log[0]?.[1]).toContain('"names":"anodes.upgrade.listSeparatorb"');
  });

  test('被取消时不弹任何 toast', () => {
    const rec = recorder();
    reportBatchSummary(t, rec.toasts, {
      succeeded: 1,
      failed: 1,
      failedNames: ['a'],
      cancelled: true,
    });
    expect(rec.log).toEqual([]);
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
