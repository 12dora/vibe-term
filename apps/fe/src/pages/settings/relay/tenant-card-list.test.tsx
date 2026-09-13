// 窄屏（sm 以下）的租户记录卡：编号截断 + 复制、备注、两条弱化信息行，三个动作收进 ⋯。
// 无 DOM 测试环境，用 react-dom/server 静态渲染；直接渲染卡片列表，不桩 matchMedia
// （桩会顺着全局泄漏给同进程的其它用例）。Base UI 的菜单走 portal，这里只断言触发器。

import { describe, expect, test } from 'bun:test';
import type { RelayTenantSummary } from '@vibeterm/api-client/relay/admin-api';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { TenantCardList } = await import('./tenant-card-list');

const TENANT_ID = '0123456789abcdef0123456789abcdef';

function tenant(patch: Partial<RelayTenantSummary> = {}): RelayTenantSummary {
  return {
    id: TENANT_ID,
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

function render(tenants: RelayTenantSummary[], selectedTenantId: string | null = null): string {
  return renderToStaticMarkup(
    <TenantCardList
      tenants={tenants}
      defaultQuota={{ maxNodes: 8, maxStreams: 16, bandwidthBytesPerSec: 524_288 }}
      now={1_700_000_060_000}
      busyTenantId={null}
      selectedTenantId={selectedTenantId}
      onSelect={() => undefined}
      onEdit={() => undefined}
      onKick={() => undefined}
      onRemove={() => undefined}
      onSaveLabel={() => undefined}
    />
  );
}

describe('窄屏租户记录卡', () => {
  test('不渲染表格；容器与行的 testid 与宽表一致', () => {
    const html = render([tenant()]);
    expect(html).not.toContain('<table');
    expect(html).toContain('data-testid="relay-tenants-table"');
    expect(html).toContain(`data-testid="relay-tenant-row-${TENANT_ID}"`);
  });

  test('编号截断显示，旁边留复制与 ⋯', () => {
    const html = render([tenant()]);
    expect(html).toContain('0123456789ab…');
    expect(html).toContain(`data-testid="relay-tenant-${TENANT_ID}-copy"`);
    expect(html).toContain(`data-testid="relay-tenant-menu-${TENANT_ID}"`);
  });

  test('用量与配额各占一行，各自带前导标签', () => {
    const html = render([tenant()]);
    expect(html).toContain('relay.admin.tenants.mobile.usage');
    expect(html).toContain('relay.admin.tenants.columns.quota');
    expect(html).toContain(`data-testid="relay-tenant-nodes-${TENANT_ID}"`);
    expect(html).toContain(`data-testid="relay-tenant-quota-default-${TENANT_ID}"`);
    expect(html).toContain(`data-testid="relay-tenant-label-${TENANT_ID}"`);
  });

  test('令牌纪元只在被踢过时占一段', () => {
    expect(render([tenant()])).not.toContain('relay.admin.epochValue');
    const kicked = render([tenant({ kicked: true })]);
    expect(kicked).toContain('relay.admin.epochValue');
    expect(kicked).toContain(`data-testid="relay-tenant-kicked-${TENANT_ID}"`);
  });

  test('整张卡可点选，选中态带 aria-selected', () => {
    expect(render([tenant()])).toContain('aria-selected="false"');
    expect(render([tenant()], TENANT_ID)).toContain('aria-selected="true"');
    expect(render([tenant()])).toContain('relay.admin.tenants.selectHint');
  });

  test('空列表给一句空态', () => {
    expect(render([])).toContain('relay.admin.tenants.empty');
  });
});
