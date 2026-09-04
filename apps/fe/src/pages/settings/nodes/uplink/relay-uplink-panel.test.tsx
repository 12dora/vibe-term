// 「连接」段的中继形态：链路行、提醒堆、三级操作。
// 无 DOM 测试环境，用 react-dom/server 静态渲染；菜单走 portal，静态渲染看不到，
// 因此菜单内容单独渲染 `RelayActionsMenuList`。

import { describe, expect, test } from 'bun:test';
import type { UseMeshRelayResult } from '@/node/mesh-relay';
import type { RelayLinkStatus } from '@tmex/api-client/relay/tenant-api';
import { Children, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RelayActionsController } from '../relay/use-relay-actions';
import { type RelayMenuAction, relayActionMenu } from './relay-targets';
import { RelayActionsMenuList, RelayUplinkPanel } from './relay-uplink-panel';

function link(overrides: Partial<RelayLinkStatus> = {}): RelayLinkStatus {
  return {
    url: 'https://relay.example.com',
    priority: 1,
    online: true,
    attached: true,
    rttMs: null,
    lastError: null,
    kicked: false,
    ...overrides,
  };
}

const RELAY_MODE = {
  mode: 'relay',
  relayMode: true,
  quota: null,
  tenantId: 'aabbccddeeff00112233445566778899',
  relays: [link()],
  ordered: [link()],
  attached: link(),
  metaEpoch: 1,
  nodesViaRelay: 2,
  reauthRequired: false,
  readmitPending: 0,
  writable: true,
  kicked: false,
  loading: false,
  error: null,
  loadedAt: 1,
  unsupported: false,
  refresh: () => undefined,
} satisfies UseMeshRelayResult;

const IDLE_ACTIONS: RelayActionsController = {
  enroll: null,
  confirm: null,
  busy: false,
  error: null,
  openEnroll: () => undefined,
  closeEnroll: () => undefined,
  requestConfirm: () => undefined,
  dismissConfirm: () => undefined,
  submitEnroll: () => Promise.resolve(),
  runConfirm: () => Promise.resolve(),
  readmitMembers: () => Promise.resolve(),
  metaPending: [],
  retryMetaKey: () => Promise.resolve(),
  packPending: false,
  retryPack: () => Promise.resolve(),
};

function render(props: Partial<Parameters<typeof RelayUplinkPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    <RelayUplinkPanel relay={RELAY_MODE} actions={IDLE_ACTIONS} {...props} />
  );
}

describe('中继链路与操作', () => {
  test('链路行 + 主按钮 + 次级菜单 + 危险区，各占一处', () => {
    const html = render();
    expect(html).toContain('data-testid="local-uplink-relay-panel"');
    expect(html).toContain('data-testid="nodes-relay-rows"');
    expect(html).toContain('data-testid="nodes-relay-add"');
    expect(html).toContain('data-testid="nodes-relay-menu"');
    expect(html).toContain('data-testid="nodes-relay-leave"');
    // 重输口令 / 轮换 / 移除都收进菜单，明面上不再摆一排按钮
    expect(html).not.toContain('data-testid="nodes-relay-rotate"');
    expect(html).not.toContain('data-testid="nodes-relay-reauth-menu"');
  });

  test('「要改回 Hub 先离开中继」只是一句灰字提示，可以关掉', () => {
    expect(render()).toContain('data-testid="nodes-relay-leave-first"');
    expect(render({ showLeaveFirstHint: false })).not.toContain(
      'data-testid="nodes-relay-leave-first"'
    );
  });

  test('旧节点没有这族路由：只留链路行，不摆任何点了必报错的按钮', () => {
    const html = render({ relay: { ...RELAY_MODE, unsupported: true, ordered: [], relays: [] } });
    expect(html).toContain('data-testid="nodes-relay-empty"');
    expect(html).not.toContain('data-testid="nodes-relay-add"');
    expect(html).not.toContain('data-testid="nodes-relay-leave"');
  });

  test('租户编号、元数据代数、配额都不在这一段（它们在连接详情里）', () => {
    const html = render();
    expect(html).not.toContain('data-testid="nodes-relay-tenant-id"');
    expect(html).not.toContain('data-testid="nodes-relay-meta"');
    expect(html).not.toContain('data-testid="nodes-relay-quota"');
  });
});

describe('提醒堆', () => {
  test('令牌失效：红条 + 重新输入口令', () => {
    const html = render({ relay: { ...RELAY_MODE, kicked: true } });
    expect(html).toContain('data-testid="nodes-relay-reauth"');
    expect(html).toContain('data-testid="nodes-relay-reauth-action"');
    expect(html).toContain('relay.tenant.reauth.notice');
  });

  test('有旧根签的成员：告警 + 重新确认成员', () => {
    const html = render({ relay: { ...RELAY_MODE, readmitPending: 2 } });
    expect(html).toContain('data-testid="nodes-relay-readmit"');
    expect(html).toContain('data-testid="nodes-relay-readmit-action"');
    expect(html).toContain('nodes.readmit.notice');
  });

  test('元数据密钥欠账与密封包欠账各一条', () => {
    const html = render({
      actions: {
        ...IDLE_ACTIONS,
        metaPending: [{ nodeId: 'n1' }] as unknown as RelayActionsController['metaPending'],
        packPending: true,
      },
    });
    expect(html).toContain('data-testid="nodes-relay-meta-pending"');
    expect(html).toContain('data-testid="nodes-relay-meta-retry"');
    expect(html).toContain('data-testid="nodes-relay-pack-pending"');
    expect(html).toContain('data-testid="nodes-relay-pack-retry"');
  });

  test('一条中继都没挂上：只给一句陈述，不给动作', () => {
    const html = render({ relay: { ...RELAY_MODE, writable: false } });
    expect(html).toContain('data-testid="nodes-relay-detached"');
    expect(html).toContain('relay.tenant.notAttached');
  });

  test('动作进行中时提醒里的按钮禁用', () => {
    const html = render({
      relay: { ...RELAY_MODE, readmitPending: 1 },
      actions: { ...IDLE_ACTIONS, busy: true },
    });
    expect(html).toMatch(/nodes-relay-readmit-action"[^>]*disabled/);
  });

  test('一切正常时一条提醒都不出', () => {
    const html = render();
    expect(html).not.toContain('data-testid="nodes-relay-readmit"');
    expect(html).not.toContain('data-testid="nodes-relay-detached"');
    expect(html).not.toContain('data-testid="nodes-relay-reauth"');
  });
});

describe('次级菜单的渲染', () => {
  // 菜单内容走 portal，SSR 什么都不输出：直接对元素树断言（同 `BulkActionsMenuList`）。
  test('条目按 relayActionMenu 的次序渲染，各带自己的 testId 与回调', () => {
    const picked: RelayMenuAction[] = [];
    const items = relayActionMenu([
      link({ url: 'https://a.example' }),
      link({ url: 'https://b.example', attached: false, priority: 2 }),
    ]);
    const list = RelayActionsMenuList({
      items,
      label: (item) => `${item.kind}:${item.params?.host ?? ''}`,
      onSelect: (item) => {
        picked.push(item);
      },
    }) as ReactElement<{ children?: ReactNode }>;
    const rendered = Children.toArray(list.props.children) as ReactElement<{
      'data-testid'?: string;
      onClick?: () => void;
    }>[];
    expect(rendered.map((item) => item.props['data-testid'])).toEqual([
      'nodes-relay-reauth-menu',
      'nodes-relay-rotate',
      'nodes-relay-remove-a.example',
      'nodes-relay-remove-b.example',
    ]);
    rendered[3]?.props.onClick?.();
    expect(picked[0]?.url).toBe('https://b.example');
  });
});
