// 远程内存限额：资格分拣、批量写入、失败文案，以及两个对话框正文与菜单项的静态渲染。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 nodes-management 测试同一套做法）。

import { describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import { ApiError } from '@vibeterm/api-client';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS, type WindowMemorySettings } from '@vibeterm/shared';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import { Children, type ReactElement, type ReactNode } from 'react';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const {
  memoryLimitsErrorText,
  memoryLimitsFailureLabels,
  memoryLimitsSkipReason,
  memoryLimitsSummaryText,
  memoryLimitsUnsupportedDevices,
  planMemoryLimits,
  runMemoryLimitsBatch,
  runMemoryLimitsSave,
} = await import('./node-memory-limits');
const { BulkMemoryDialogBody } = await import('./bulk-memory-dialog');
const { NodeMemoryDialogBody } = await import('./node-memory-dialog');
const { NodeMoreMenuList } = await import('./node-more-menu');
const { bulkMenuStates } = await import('./bulk-actions-menu');

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
    version: '2.7.3',
    directCapable: false,
    loggedIn: true,
    inventory: null,
    isSelf: false,
    lastSeenAt: null,
    status: null,
    certificate: null,
    certSig: null,
    ...overrides,
  };
}

describe('内存限额资格分拣', () => {
  test('在线、已登录、未暂停、版本够新：可写', () => {
    expect(memoryLimitsSkipReason(row({ id: 'ok' }))).toBeNull();
  });

  test('离线 / 未登录 / 已暂停 / 版本低于 2.7.0 各自给出原因', () => {
    expect(memoryLimitsSkipReason(row({ id: 'a', online: false }))).toBe('offline');
    expect(memoryLimitsSkipReason(row({ id: 'b', loggedIn: false }))).toBe('loginRequired');
    expect(memoryLimitsSkipReason(row({ id: 'c', paused: true }))).toBe('paused');
    expect(memoryLimitsSkipReason(row({ id: 'd', version: '2.6.9' }))).toBe('tooOld');
  });

  test('本机走无前缀客户端：离线 / 未登录 / 暂停都不拦，只看版本', () => {
    expect(memoryLimitsSkipReason(row({ id: 'self', isSelf: true, online: false }))).toBeNull();
    expect(memoryLimitsSkipReason(row({ id: 'self', isSelf: true, loggedIn: false }))).toBeNull();
    expect(memoryLimitsSkipReason(row({ id: 'self', isSelf: true, paused: true }))).toBeNull();
    expect(memoryLimitsSkipReason(row({ id: 'self', isSelf: true, version: '2.6.0' }))).toBe(
      'tooOld'
    );
  });

  test('版本未知或无法解析不预禁：交给打开后的 404 兜底', () => {
    expect(memoryLimitsSkipReason(row({ id: 'e', version: null }))).toBeNull();
    expect(memoryLimitsSkipReason(row({ id: 'f', version: '2.6.9_dev' }))).toBeNull();
  });

  test('planMemoryLimits 把选中行分成目标与跳过', () => {
    const plan = planMemoryLimits([
      row({ id: 'ok' }),
      row({ id: 'off', online: false }),
      row({ id: 'out', loggedIn: false }),
      row({ id: 'halt', paused: true }),
      row({ id: 'old', version: '1.1.13' }),
    ]);
    expect(plan.targets.map((item) => item.id)).toEqual(['ok']);
    expect(plan.skipped.map((item) => [item.row.id, item.reason])).toEqual([
      ['off', 'offline'],
      ['out', 'loginRequired'],
      ['halt', 'paused'],
      ['old', 'tooOld'],
    ]);
  });
});

describe('批量写入', () => {
  const settings: WindowMemorySettings = { ...WINDOW_MEMORY_SETTINGS_DEFAULTS, memoryMaxMb: 2048 };

  test('一台失败不影响其余几台，成败双计且失败按输入顺序', async () => {
    const written: string[] = [];
    const summary = await runMemoryLimitsBatch({
      targets: [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })],
      settings,
      t,
      io: {
        get: () => Promise.reject(new Error('unused')),
        put: (target, next) => {
          if (target.id === 'b') return Promise.reject(new Error('boom'));
          written.push(target.id);
          return Promise.resolve(next);
        },
      },
    });
    expect(written.sort()).toEqual(['a', 'c']);
    expect(summary.saved).toBe(2);
    expect(summary.failed).toEqual([{ id: 'b', name: 'b', message: 'boom' }]);
  });

  test('并发不超过上限，且每台都用同一份限额', async () => {
    let inflight = 0;
    let peak = 0;
    const bodies: WindowMemorySettings[] = [];
    const targets = Array.from({ length: 7 }, (_, index) => row({ id: `n${index}` }));
    const summary = await runMemoryLimitsBatch({
      targets,
      settings,
      t,
      io: {
        get: () => Promise.reject(new Error('unused')),
        put: async (_target, next) => {
          inflight += 1;
          peak = Math.max(peak, inflight);
          await Promise.resolve();
          bodies.push(next);
          inflight -= 1;
          return next;
        },
      },
    });
    expect(summary.saved).toBe(7);
    expect(peak).toBeLessThanOrEqual(3);
    expect(bodies.every((body) => body.memoryMaxMb === 2048)).toBe(true);
  });

  test('目标为空时不发请求', async () => {
    const summary = await runMemoryLimitsBatch({
      targets: [],
      settings,
      t,
      io: {
        get: () => Promise.reject(new Error('unused')),
        put: () => Promise.reject(new Error('should not run')),
      },
    });
    expect(summary).toEqual({ saved: 0, failed: [] });
  });

  test('汇总文案分成功与失败两档', () => {
    expect(memoryLimitsSummaryText(t, { saved: 3, failed: [] })).toEqual({
      level: 'success',
      text: 'nodes.memory.summary:{"count":3}',
    });
    const failed = memoryLimitsSummaryText(t, {
      saved: 1,
      failed: [
        { id: 'a', name: 'a', message: 'x' },
        { id: 'b', name: 'b', message: 'y' },
      ],
    });
    expect(failed.level).toBe('error');
    expect(failed.text).toContain('"names":"a、b"');
  });
});

describe('失败文案', () => {
  test('转发器的三种信封各自换成人话，其余保留原始 message', () => {
    expect(memoryLimitsErrorText(t, new ApiError(503, 'x', { code: 'NODE_UNREACHABLE' }))).toBe(
      'nodes.memory.errors.unreachable'
    );
    expect(memoryLimitsErrorText(t, new ApiError(401, 'x', { code: 'NODE_LOGIN_REQUIRED' }))).toBe(
      'nodes.memory.errors.loginRequired'
    );
    expect(memoryLimitsErrorText(t, new ApiError(404, 'not found'))).toBe(
      'nodes.memory.errors.unsupported'
    );
    expect(memoryLimitsErrorText(t, new ApiError(405, 'nope'))).toBe(
      'nodes.memory.errors.unsupported'
    );
    expect(memoryLimitsErrorText(t, new ApiError(400, 'memoryHighMb must be an integer'))).toBe(
      'memoryHighMb must be an integer'
    );
    expect(memoryLimitsErrorText(t, new Error('offline'))).toBe('offline');
  });
});

describe('行内「内存限额」菜单项', () => {
  function items(memoryDisabled: boolean, memoryTitle?: string) {
    const list = NodeMoreMenuList({
      row: { id: 'qq' },
      paused: false,
      pauseDisabled: false,
      memoryDisabled,
      memoryTitle,
      labels: { detail: '详情', memory: '内存限额', pause: '暂停' },
      onDetail: () => undefined,
      onMemory: () => undefined,
      onPause: () => undefined,
    }) as ReactElement<{ children?: ReactNode }>;
    return Children.toArray(list.props.children) as ReactElement<{
      'data-testid'?: string;
      disabled?: boolean;
      title?: string;
      children?: ReactNode;
    }>[];
  }

  test('可点时不带禁用原因', () => {
    const memory = items(false)[1];
    expect(memory.props['data-testid']).toBe('nodes-memory-qq');
    expect(memory.props.disabled).toBe(false);
    expect(memory.props.title).toBeUndefined();
    expect(JSON.stringify(memory.props.children)).toContain('内存限额');
  });

  test('四种跳过原因都禁用菜单项并把原因写进 title', () => {
    for (const reason of ['offline', 'loginRequired', 'paused', 'tooOld'] as const) {
      const title = t('nodes.memory.unavailable', { reason: `nodes.memory.skip.${reason}` });
      const memory = items(true, title)[1];
      expect(memory.props.disabled).toBe(true);
      expect(memory.props.title).toBe(title);
    }
  });
});

describe('批量「内存限额」菜单项', () => {
  const base = {
    selectedCount: 2,
    eligibleUpgradeCount: 2,
    selfIncluded: false,
    latestKnown: true,
    upgradeBusy: false,
    restoring: false,
    writable: true,
    blockedHint: 'relay.tenant.notAttached',
    uninstallRunning: false,
    revoking: false,
    eligiblePauseCount: 2,
    eligibleResumeCount: 0,
    pauseBusy: false,
    eligibleMemoryCount: 2,
    memoryBusy: false,
  };

  test('有可写的节点就可点', () => {
    expect(bulkMenuStates(base, t).memory).toEqual({ disabled: false });
  });

  test('没勾选 / 无可写节点 / 正在写入：各自禁用并说明原因', () => {
    expect(bulkMenuStates({ ...base, selectedCount: 0 }, t).memory.title).toBe(
      'nodes.selection.none'
    );
    expect(bulkMenuStates({ ...base, eligibleMemoryCount: 0 }, t).memory.title).toBe(
      'nodes.memory.selectionNone'
    );
    expect(bulkMenuStates({ ...base, memoryBusy: true }, t).memory.title).toBe('nodes.memory.busy');
  });

  test('写入期间其它批量动作一并锁住', () => {
    const busy = bulkMenuStates({ ...base, memoryBusy: true }, t);
    expect(busy.upgrade.disabled).toBe(true);
    expect(busy.uninstall.disabled).toBe(true);
    expect(busy.pause.title).toBe('nodes.memory.busy');
  });
});

describe('对话框正文', () => {
  test('批量框列出目标、跳过原因与上一批的失败节点', () => {
    const html = renderToStaticMarkup(
      <BulkMemoryDialogBody
        plan={planMemoryLimits([row({ id: 'ok' }), row({ id: 'old', version: '2.0.0' })])}
        failures={[{ id: 'ok', name: 'ok', message: '该节点当前不可达。' }]}
      />
    );
    expect(html).toContain('data-testid="nodes-memory-target-ok"');
    expect(html).toContain('data-testid="nodes-memory-skip-old"');
    expect(html).toContain('nodes.memory.skip.tooOld');
    expect(html).toContain('该节点当前不可达。');
  });

  test('一台都写不了时给出说明，且没有目标清单', () => {
    const html = renderToStaticMarkup(
      <BulkMemoryDialogBody
        plan={planMemoryLimits([row({ id: 'off', online: false })])}
        failures={[]}
      />
    );
    expect(html).toContain('data-testid="nodes-memory-none"');
    expect(html).not.toContain('nodes-memory-target-');
  });

  test('单节点框：读取中 / 读取失败 / 表单三态', () => {
    const loading = renderToStaticMarkup(
      <NodeMemoryDialogBody
        nodeId="qq"
        draft={null}
        errors={{}}
        loadError={null}
        saving={false}
        onChange={() => undefined}
      />
    );
    expect(loading).toContain('data-testid="nodes-memory-loading-qq"');

    const failed = renderToStaticMarkup(
      <NodeMemoryDialogBody
        nodeId="qq"
        draft={null}
        errors={{}}
        loadError="内存限额读取失败：该节点当前不可达。"
        saving={false}
        onChange={() => undefined}
      />
    );
    expect(failed).toContain('data-testid="nodes-memory-load-failed-qq"');

    const form = renderToStaticMarkup(
      <NodeMemoryDialogBody
        nodeId="qq"
        draft={{
          enabled: true,
          memoryHighMb: '1024',
          memoryMaxMb: '2048',
          memorySwapMaxMb: '0',
          sampleIntervalSec: '5',
        }}
        errors={{ memoryHighMb: 'settings.nodes.memory.highAboveMax' }}
        saving={false}
        loadError={null}
        onChange={() => undefined}
      />
    );
    // 字段 id 带节点前缀：本机卡那份表单同页渲染时不会撞车。
    expect(form).toContain('id="nodes-memory-qq-memoryHighMb"');
    expect(form).toContain('data-testid="nodes-memory-qq-enabled"');
    expect(form).toContain('settings.nodes.memory.highAboveMax');
  });
});

describe('单节点保存的在途保护', () => {
  const draft = {
    enabled: true,
    memoryHighMb: '1024',
    memoryMaxMb: '2048',
    memorySwapMaxMb: '0',
    sampleIntervalSec: '5',
  };

  function sinks(alive: () => boolean) {
    const calls: string[] = [];
    return {
      calls,
      params: {
        draft,
        t,
        alive,
        setSaving: (saving: boolean) => calls.push(`saving:${saving}`),
        setErrors: () => calls.push('errors'),
        setDraft: () => calls.push('draft'),
        onSaved: () => calls.push('onSaved'),
        notify: (level: string, text: string) => calls.push(`toast:${level}:${text}`),
      },
    };
  }

  test('仍挂着时照常回写草稿、弹成功提示并通知父级', async () => {
    const { calls, params } = sinks(() => true);
    await runMemoryLimitsSave({
      ...params,
      put: (settings) => Promise.resolve(settings),
    });
    expect(calls).toEqual([
      'saving:true',
      'errors',
      'saving:false',
      'draft',
      'toast:success:settings.nodes.memory.saved',
      'onSaved',
    ]);
  });

  test('PUT 返回前对话框已卸载：不再写 state、不弹提示', async () => {
    let alive = true;
    const { calls, params } = sinks(() => alive);
    const pending = runMemoryLimitsSave({
      ...params,
      put: async (settings) => {
        alive = false; // 请求在途时组件被卸载
        await Promise.resolve();
        return settings;
      },
    });
    await pending;
    expect(calls).toEqual(['saving:true']);
  });

  test('失败也走同一道闸：卸载后不弹失败提示', async () => {
    let alive = true;
    const { calls, params } = sinks(() => alive);
    await runMemoryLimitsSave({
      ...params,
      put: async () => {
        alive = false;
        throw new ApiError(503, 'x', { code: 'NODE_UNREACHABLE' });
      },
    });
    expect(calls).toEqual(['saving:true']);

    const live = sinks(() => true);
    await runMemoryLimitsSave({
      ...live.params,
      put: () => Promise.reject(new ApiError(503, 'x', { code: 'NODE_UNREACHABLE' })),
    });
    expect(live.calls.at(-1)).toContain('toast:error:settings.nodes.memory.saveFailed');
    expect(live.calls.at(-1)).toContain('nodes.memory.errors.unreachable');
  });

  test('校验没过时一次请求都不发，也不通知父级', async () => {
    const { calls, params } = sinks(() => true);
    await runMemoryLimitsSave({
      ...params,
      draft: { ...draft, memoryMaxMb: 'x' },
      put: () => Promise.reject(new Error('should not run')),
    });
    expect(calls).toEqual(['saving:true', 'errors', 'saving:false']);
  });
});

describe('失败清单的重名消歧', () => {
  test('名字唯一时照原样显示', () => {
    expect(
      memoryLimitsFailureLabels(t, [{ id: 'aabbccdd11', name: '工作室', message: 'x' }])
    ).toEqual([{ id: 'aabbccdd11', label: '工作室', message: 'x' }]);
  });

  test('两台重名各自补上 id 前 8 位', () => {
    const labels = memoryLimitsFailureLabels(t, [
      { id: 'aabbccdd11', name: '工作室', message: 'x' },
      { id: 'eeff001122', name: '工作室', message: 'y' },
      { id: 'zz', name: '书房', message: 'z' },
    ]);
    expect(labels.map((item) => item.label)).toEqual([
      'nodes.memory.failedNameWithId:{"name":"工作室","id":"aabbccdd"}',
      'nodes.memory.failedNameWithId:{"name":"工作室","id":"eeff0011"}',
      '书房',
    ]);
  });

  test('汇总文案用消歧后的名字', () => {
    const summary = memoryLimitsSummaryText(t, {
      saved: 0,
      failed: [
        { id: 'aabbccdd11', name: '工作室', message: 'x' },
        { id: 'eeff001122', name: '工作室', message: 'y' },
      ],
    });
    expect(summary.text).toContain('aabbccdd');
    expect(summary.text).toContain('eeff0011');
  });

  test('失败清单按 id 分行，重名不会合成同一个 key', () => {
    const html = renderToStaticMarkup(
      <BulkMemoryDialogBody
        plan={planMemoryLimits([row({ id: 'aabbccdd11' }), row({ id: 'eeff001122' })])}
        failures={[
          { id: 'aabbccdd11', name: '工作室', message: '该节点当前不可达。' },
          { id: 'eeff001122', name: '工作室', message: '须先登录该节点。' },
        ]}
      />
    );
    expect(html).toContain('data-testid="nodes-memory-failed-aabbccdd11"');
    expect(html).toContain('data-testid="nodes-memory-failed-eeff001122"');
    expect(html).toContain('该节点当前不可达。');
    expect(html).toContain('须先登录该节点。');
  });
});

describe('「写入设置」不等于「限额生效」', () => {
  test('只挑已连接且明确限不了的设备；null 与已断开都不算', () => {
    expect(
      memoryLimitsUnsupportedDevices({
        devices: [
          {
            deviceId: 'a',
            deviceName: '工作室',
            connected: true,
            supported: true,
            limitsSupported: false,
            windows: [],
          },
          {
            deviceId: 'b',
            deviceName: '书房',
            connected: true,
            supported: true,
            limitsSupported: null,
            windows: [],
          },
          {
            deviceId: 'c',
            deviceName: '离线机',
            connected: false,
            supported: true,
            limitsSupported: false,
            windows: [],
          },
          {
            deviceId: 'd',
            deviceName: '新机',
            connected: true,
            supported: true,
            limitsSupported: true,
            windows: [],
          },
        ],
      })
    ).toEqual(['工作室']);
  });

  test('单节点框把受影响设备与生效条件摆在表单上方', () => {
    const html = renderToStaticMarkup(
      <NodeMemoryDialogBody
        nodeId="qq"
        draft={{
          enabled: true,
          memoryHighMb: '1024',
          memoryMaxMb: '2048',
          memorySwapMaxMb: '0',
          sampleIntervalSec: '5',
        }}
        errors={{}}
        loadError={null}
        saving={false}
        unsupportedDevices={['工作室', '书房']}
        onChange={() => undefined}
      />
    );
    expect(html).toContain('data-testid="nodes-memory-unsupported-qq"');
    expect(html).toContain('settings.nodes.memory.limitsUnsupported');
    expect(html).toContain('settings.nodes.memory.limitsUnsupportedHint');
    // 提示归提示，表单照常可用。
    expect(html).toContain('data-testid="nodes-memory-qq-enabled"');
  });

  test('没有受影响的设备就不提示', () => {
    const html = renderToStaticMarkup(
      <NodeMemoryDialogBody
        nodeId="qq"
        draft={null}
        errors={{}}
        loadError={null}
        saving={false}
        onChange={() => undefined}
      />
    );
    expect(html).not.toContain('nodes-memory-unsupported-qq');
  });

  test('批量框常驻一行说明：写的是设置，生效看宿主', () => {
    const html = renderToStaticMarkup(
      <BulkMemoryDialogBody plan={planMemoryLimits([row({ id: 'ok' })])} failures={[]} />
    );
    expect(html).toContain('data-testid="nodes-memory-bulk-effect"');
    expect(html).toContain('nodes.memory.bulkEffectHint');
  });
});
