// 中继管理页新增的三块：两个「更多」菜单、默认配额对话框正文、接入节点卡。
// 无 DOM 测试环境：菜单内容当普通函数调用后对元素树断言（同 BulkActionsMenuList），
// 其余用 react-dom/server 静态渲染。

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RelayQuota, RelayTenantSummary } from '@tmex/api-client/relay/admin-api';
import { installWindowStorage } from '@tmex/stores/test-utils';
import type { ReactElement } from 'react';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { RelayAdminMenuList, TenantsMenuList } = await import('./relay-menus');
const { DefaultQuotaDialogBody } = await import('./default-quota-dialog');
const { RelayMembersCard, MemberStateFilterGroup, tenantScopeLabel } = await import(
  './members-card'
);
const { quotaToDraft } = await import('./relay-forms');
const { relayMetricsMember } = await import('./relay-metrics-fixture');

const QUOTA: RelayQuota = { maxNodes: 8, maxStreams: 16, bandwidthBytesPerSec: 524_288 };

type MenuItemElement = ReactElement<{ 'data-testid'?: string; onClick?: () => void }>;

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

describe('页头「更多」', () => {
  test('只有「修改接入密码」一项，点它开口令框', () => {
    let opened = 0;
    const item = RelayAdminMenuList({
      label: '修改接入密码',
      onChangePassword: () => {
        opened += 1;
      },
    }) as MenuItemElement;
    expect(item.props['data-testid']).toBe('relay-password-change');
    item.props.onClick?.();
    expect(opened).toBe(1);
  });
});

describe('租户卡「更多」', () => {
  test('「默认配额…」点开对话框', () => {
    let opened = 0;
    const item = TenantsMenuList({
      label: '默认配额…',
      onDefaultQuota: () => {
        opened += 1;
      },
    }) as MenuItemElement;
    expect(item.props['data-testid']).toBe('relay-default-quota-open');
    item.props.onClick?.();
    expect(opened).toBe(1);
  });
});

describe('默认配额对话框', () => {
  test('正文摆配额三件套', () => {
    const html = renderToStaticMarkup(
      <DefaultQuotaDialogBody
        draft={quotaToDraft(QUOTA)}
        errors={{}}
        busy={false}
        error={null}
        onChange={() => undefined}
      />
    );
    expect(html).toContain('data-testid="relay-default-quota-body"');
    expect(html).toContain('data-testid="relay-default-quota-max-nodes"');
    expect(html).toContain('data-testid="relay-default-quota-max-streams"');
    expect(html).toContain('data-testid="relay-default-quota-bandwidth"');
    expect(html).not.toContain('data-testid="relay-default-quota-error"');
  });

  test('提交失败时正文里摆错误', () => {
    const html = renderToStaticMarkup(
      <DefaultQuotaDialogBody
        draft={quotaToDraft(QUOTA)}
        errors={{}}
        busy
        error="配额更新失败：boom"
        onChange={() => undefined}
      />
    );
    expect(html).toContain('data-testid="relay-default-quota-error"');
    expect(html).toContain('配额更新失败：boom');
  });

  // 关框由控制器在写成功后做（与改密码同一条路径）；无 DOM 环境驱动不了，只能在源码层面钉住。
  test('存成功即关框', () => {
    const source = readFileSync(join(import.meta.dir, 'use-relay-controller.ts'), 'utf8');
    expect(source).toContain('await quota.run(() => api.updateDefaultQuota(next))');
    expect(source).toContain('setQuotaOpen(false)');
  });
});

describe('接入节点卡', () => {
  const members = [
    relayMetricsMember({ nodeId: 'aaaa1111', name: '北京', tenantId: 't1' }),
    relayMetricsMember({ nodeId: 'bbbb2222', name: '上海', tenantId: 't2', online: false }),
  ];

  test('摆检索框、状态分段与总数', () => {
    const html = renderToStaticMarkup(
      <RelayMembersCard members={members} now={0} tenant={null} onClearTenant={() => undefined} />
    );
    expect(html).toContain('data-testid="relay-members-search"');
    expect(html).toContain('data-testid="relay-members-filter-all"');
    expect(html).toContain('data-testid="relay-members-filter-online"');
    expect(html).toContain('data-testid="relay-members-filter-offline"');
    expect(html).toContain('relay.metrics.members.total');
    expect(html).toContain('data-testid="relay-member-row-aaaa1111"');
    expect(html).toContain('data-testid="relay-member-row-bbbb2222"');
    expect(html).not.toContain('data-testid="relay-members-tenant-scope"');
  });

  test('选中租户后只留该租户的节点，卡头写明范围', () => {
    const html = renderToStaticMarkup(
      <RelayMembersCard
        members={members}
        now={0}
        tenant={tenant({ id: 't2', label: '合肥团队' })}
        onClearTenant={() => undefined}
      />
    );
    expect(html).toContain('data-testid="relay-members-tenant-scope"');
    expect(html).toContain('合肥团队');
    expect(html).toContain('data-testid="relay-member-row-bbbb2222"');
    expect(html).not.toContain('data-testid="relay-member-row-aaaa1111"');
  });

  test('租户名下一个节点都没有：出「没有匹配」而不是「还没有节点接入」', () => {
    const html = renderToStaticMarkup(
      <RelayMembersCard
        members={members}
        now={0}
        tenant={tenant({ id: 'nobody' })}
        onClearTenant={() => undefined}
      />
    );
    expect(html).toContain('data-testid="relay-members-no-match"');
    expect(html).not.toContain('data-testid="relay-members-empty"');
  });

  test('一个成员都没有时才说「还没有节点接入」', () => {
    const html = renderToStaticMarkup(
      <RelayMembersCard members={[]} now={0} tenant={null} onClearTenant={() => undefined} />
    );
    expect(html).toContain('data-testid="relay-members-empty"');
  });

  test('默认按节点名升序，不再是在线优先', () => {
    const html = renderToStaticMarkup(
      <RelayMembersCard
        members={[
          relayMetricsMember({ nodeId: 'zzzz', name: 'zulu' }),
          relayMetricsMember({ nodeId: 'aaaa', name: 'alpha', online: false }),
        ]}
        now={0}
        tenant={null}
        onClearTenant={() => undefined}
      />
    );
    expect(html.indexOf('relay-member-row-aaaa')).toBeLessThan(
      html.indexOf('relay-member-row-zzzz')
    );
  });

  test('状态分段把当前档标成按下态', () => {
    const html = renderToStaticMarkup(
      <MemberStateFilterGroup value="online" onChange={() => undefined} />
    );
    expect(html).toContain('data-testid="relay-members-state-filter"');
    expect(html).toContain('aria-pressed="true"');
  });

  test('租户范围标签：有备注用备注，没有就用短编号', () => {
    expect(tenantScopeLabel(tenant({ label: ' 合肥团队 ' }))).toBe('合肥团队');
    expect(tenantScopeLabel(tenant({ label: '  ' }))).toBe('0123456789ab…');
    expect(tenantScopeLabel(tenant())).toBe('0123456789ab…');
  });
});
