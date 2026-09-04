// 「中继」标签的四种收尾（未启用 / 未登录 / 加载失败 / 有数据）。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 NodesTab 测试同一套做法），
// 因此只断言结构与 testId，不驱动交互。

import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiClient } from '@tmex/api-client/client';
import type { RelayStatusResponse, RelayTenantSummary } from '@tmex/api-client/relay/admin-api';
import { RelayAdminApi } from '@tmex/api-client/relay/admin-api';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { RelayTab } = await import('./relay-tab');
const { resetRelayAdminStateForTest, setRelayAdminStateForTest } = await import(
  './relay-status-store'
);
const {
  getRelayMetricsState,
  refreshRelayMetrics,
  resetRelayMetricsStateForTest,
  setRelayMetricsStateForTest,
} = await import('./relay-metrics-store');
const { relayMetricsFixture: metrics } = await import('./relay-metrics-fixture');

function tenant(patch: Partial<RelayTenantSummary> = {}): RelayTenantSummary {
  return {
    id: '0123456789abcdef0123456789abcdef',
    label: null,
    createdAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    nodes: 3,
    nodesRevoked: 0,
    nodesOnline: 2,
    streams: 1,
    bytesIn: 1024,
    bytesOut: 2048,
    quota: null,
    tokenEpoch: 4,
    kicked: false,
    ...patch,
  };
}

function status(tenants: RelayTenantSummary[]): RelayStatusResponse {
  return {
    config: {
      hasPassword: true,
      passwordEpoch: 3,
      minTokenEpoch: 2,
      defaultQuota: { maxNodes: 8, maxStreams: 16, bandwidthBytesPerSec: 524_288 },
    },
    tenants,
    totals: {
      tenants: tenants.length,
      nodes: 5,
      nodesOnline: 2,
      streams: 1,
      bytesIn: 1024,
      bytesOut: 2048,
    },
  };
}

function render(): string {
  return renderToStaticMarkup(<RelayTab />);
}

afterEach(() => {
  resetRelayAdminStateForTest();
  resetRelayMetricsStateForTest();
});

describe('RelayTab 的收尾状态', () => {
  test('结论未定且还没数据：出骨架，不出正文', () => {
    const html = render();
    expect(html).toContain('data-testid="settings-relay-tab-skeleton"');
    expect(html).not.toContain('data-testid="settings-relay-tab"');
  });

  test('角色缺席：给「未启用」说明而不是空白页', () => {
    setRelayAdminStateForTest({ availability: 'unavailable' });
    const html = render();
    expect(html).toContain('data-testid="settings-relay-tab-unavailable"');
    expect(html).toContain('data-testid="relay-unavailable"');
    expect(html).not.toContain('data-testid="relay-tenants-table"');
  });

  test('未登录：给登录提示，不当成加载失败', () => {
    setRelayAdminStateForTest({ availability: 'unauthorized' });
    const html = render();
    expect(html).toContain('data-testid="settings-relay-tab-login"');
    expect(html).toContain('data-testid="relay-login-required"');
  });

  test('一次都没拉到过：错误 + 重试按钮', () => {
    setRelayAdminStateForTest({ availability: 'unknown', error: 'ECONNREFUSED' });
    const html = render();
    expect(html).toContain('data-testid="settings-relay-tab-error"');
    expect(html).toContain('data-testid="relay-retry"');
    expect(html).toContain('data-testid="relay-load-error"');
  });
});

describe('RelayTab 的正文', () => {
  test('指标面板 + 口令卡 + 默认配额表单 + 租户卡都在', () => {
    setRelayAdminStateForTest({
      availability: 'available',
      status: status([tenant()]),
      health: { ok: true, version: '1.1.23', tenants: 1, nodesOnline: 2, uptimeMs: 90_000_000 },
      loadedAt: 1_700_000_600_000,
    });
    const html = render();
    expect(html).toContain('data-testid="settings-relay-tab"');
    // 运行状态与总量已并入指标面板；指标还没拉到时那一块先摆骨架。
    expect(html).toContain('data-testid="relay-metrics-panel-skeleton"');
    expect(html).not.toContain('data-testid="relay-health-card"');
    expect(html).not.toContain('data-testid="relay-totals-card"');
    expect(html).toContain('data-testid="relay-password-card"');
    expect(html).toContain('data-testid="relay-default-quota-card"');
    expect(html).toContain('data-testid="relay-tenants-card"');
    expect(html).toContain('data-testid="relay-tenants-table"');
  });

  test('指标拉到后：面板取代骨架，趋势与接入节点表都在', () => {
    setRelayMetricsStateForTest({ data: metrics(), loadedAt: 1_700_000_600_000 });
    setRelayAdminStateForTest({ availability: 'available', status: status([tenant()]) });
    const html = render();
    expect(html).toContain('data-testid="relay-metrics-panel"');
    expect(html).not.toContain('data-testid="relay-metrics-panel-skeleton"');
    expect(html).toContain('data-testid="relay-metrics-tiles"');
    expect(html).toContain('data-testid="relay-metrics-trends"');
    expect(html).toContain('data-testid="relay-members-card"');
  });

  test('没有口令时头部卡摆出警告', () => {
    const base = status([]);
    setRelayAdminStateForTest({
      availability: 'available',
      status: { ...base, config: { ...base.config, hasPassword: false } },
    });
    expect(render()).toContain('data-testid="relay-password-unset-warning"');
  });

  test('租户行：短编号、在线数、跟随默认的徽标与三个动作', () => {
    const row = tenant();
    setRelayAdminStateForTest({ availability: 'available', status: status([row]) });
    const html = render();
    expect(html).toContain(`data-testid="relay-tenant-row-${row.id}"`);
    expect(html).toContain('0123456789ab…');
    expect(html).toContain(`data-testid="relay-tenant-quota-default-${row.id}"`);
    expect(html).toContain(`data-testid="relay-tenant-edit-${row.id}"`);
    expect(html).toContain(`data-testid="relay-tenant-kick-${row.id}"`);
    expect(html).toContain(`data-testid="relay-tenant-remove-${row.id}"`);
  });

  test('吊销过节点的租户在节点数后面挂灰色后缀', () => {
    const row = tenant({ nodesRevoked: 2 });
    setRelayAdminStateForTest({ availability: 'available', status: status([row]) });
    expect(render()).toContain(`data-testid="relay-tenant-nodes-revoked-${row.id}"`);
  });

  test('没有吊销节点时不挂后缀', () => {
    const row = tenant();
    setRelayAdminStateForTest({ availability: 'available', status: status([row]) });
    expect(render()).not.toContain(`data-testid="relay-tenant-nodes-revoked-${row.id}"`);
  });

  test('有自己配额的租户不打「默认」徽标；被踢过的行带徽标', () => {
    const row = tenant({
      quota: { maxNodes: 2, maxStreams: 2, bandwidthBytesPerSec: null },
      kicked: true,
    });
    setRelayAdminStateForTest({ availability: 'available', status: status([row]) });
    const html = render();
    expect(html).not.toContain(`data-testid="relay-tenant-quota-default-${row.id}"`);
    expect(html).toContain(`data-testid="relay-tenant-kicked-${row.id}"`);
  });

  test('一个租户都没有时表里出空态', () => {
    setRelayAdminStateForTest({ availability: 'available', status: status([]) });
    const html = render();
    expect(html).toContain('data-testid="relay-tenants-table"');
    expect(html).toContain('relay.admin.tenants.empty');
  });

  test('拉到过数据之后又失败：正文照旧，另加一条错误提示', () => {
    setRelayAdminStateForTest({
      availability: 'available',
      status: status([tenant()]),
      error: 'timeout',
    });
    const html = render();
    expect(html).toContain('data-testid="settings-relay-tab"');
    expect(html).toContain('data-testid="relay-refresh-error"');
  });
});

describe('RelayTab 的 api 注入', () => {
  test('注入的 api 上取指标只打注入的 transport，碰不到默认 client', async () => {
    const paths: string[] = [];
    const client = new ApiClient('', (url) => {
      paths.push(url);
      return Promise.resolve(new Response(JSON.stringify(metrics()), { status: 200 }));
    });
    const api = new RelayAdminApi(client);

    const realFetch = globalThis.fetch;
    let escaped = 0;
    globalThis.fetch = (() => {
      escaped += 1;
      return Promise.reject(new Error('不该走默认 client'));
    }) as unknown as typeof fetch;
    try {
      await refreshRelayMetrics(api);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(paths).toEqual(['/api/relay/metrics']);
    expect(escaped).toBe(0);
    expect(getRelayMetricsState().data).not.toBeNull();
  });

  test('标签把自己的 api 传给指标面板，而不是让它回落到默认单例', () => {
    // 无 DOM 测试环境跑不了 effect，拿不到面板真正发出的请求；
    // 这条接线只能在源码层面钉住（做法同 i18n core-coverage 测试）。
    const source = readFileSync(join(import.meta.dir, 'relay-tab.tsx'), 'utf8');
    expect(source).toContain('<RelayMetricsPanel api={api} />');
    expect(source).toContain(
      '<RelayTabBody controller={controller} status={relay.status} api={api} />'
    );
  });

  test('注入的 api 照旧驱动状态与写操作', async () => {
    const paths: string[] = [];
    const client = new ApiClient('', (url) => {
      paths.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    await new RelayAdminApi(client).metrics();
    expect(paths).toEqual(['/api/relay/metrics']);
  });
});
