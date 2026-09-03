// 「中继」标签的四种收尾（未启用 / 未登录 / 加载失败 / 有数据）。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 NodesTab 测试同一套做法），
// 因此只断言结构与 testId，不驱动交互。

import { afterEach, describe, expect, test } from 'bun:test';
import type { RelayStatusResponse, RelayTenantSummary } from '@tmex/api-client/relay/admin-api';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { RelayTab } = await import('./relay-tab');
const { resetRelayAdminStateForTest, setRelayAdminStateForTest } = await import(
  './relay-status-store'
);

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
    totals: { tenants: tenants.length, nodesOnline: 2, streams: 1, bytesIn: 1024, bytesOut: 2048 },
  };
}

function render(): string {
  return renderToStaticMarkup(<RelayTab />);
}

afterEach(() => {
  resetRelayAdminStateForTest();
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
  test('三张头部卡 + 默认配额表单 + 租户卡都在', () => {
    setRelayAdminStateForTest({
      availability: 'available',
      status: status([tenant()]),
      health: { ok: true, version: '1.1.23', tenants: 1, nodesOnline: 2, uptimeMs: 90_000_000 },
      loadedAt: 1_700_000_600_000,
    });
    const html = render();
    expect(html).toContain('data-testid="settings-relay-tab"');
    expect(html).toContain('data-testid="relay-health-card"');
    expect(html).toContain('data-testid="relay-totals-card"');
    expect(html).toContain('data-testid="relay-password-card"');
    expect(html).toContain('data-testid="relay-default-quota-card"');
    expect(html).toContain('data-testid="relay-tenants-card"');
    expect(html).toContain('data-testid="relay-tenants-table"');
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
