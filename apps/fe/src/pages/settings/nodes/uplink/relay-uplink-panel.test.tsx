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
import { SelfRelayEntry } from './uplink-section';

function link(overrides: Partial<RelayLinkStatus> = {}): RelayLinkStatus {
  return {
    url: 'https://relay.example.com',
    priority: 1,
    online: true,
    attached: true,
    rttMs: null,
    lastError: null,
    lastErrorCode: null,
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
  switchRelay: () => Promise.resolve(),
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
    // 重新输入接入密码 / 移除都收进「更多」，明面上不再摆一排按钮
    expect(html).not.toContain('data-testid="nodes-relay-reauth-menu"');
    // 「轮换元数据密钥」整条动作已经删掉
    expect(html).not.toContain('data-testid="nodes-relay-rotate"');
    expect(html).not.toContain('relay.tenant.actions.rotate');
  });

  test('只有一条中继时链路行不可选；多条时非当前那条是可点的按钮', () => {
    expect(render()).not.toContain('data-testid="nodes-relay-switch-');
    const two = [link(), link({ url: 'https://b.example', attached: false, priority: 2 })];
    const html = render({ relay: { ...RELAY_MODE, relays: two, ordered: two } });
    expect(html).toContain('data-testid="nodes-relay-switch-b.example"');
    expect(html).toContain('aria-current="true"');
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

describe('接入本机中继的入口', () => {
  // 中继角色（`relay` / `relay,node`）还没以租户身份接上自己的中继时，「连接」段只有这一块：
  // 一句陈述加一个预填好地址的按钮。全卡只此一处，链路面板里绝不重复。
  function entry(props: Partial<Parameters<typeof SelfRelayEntry>[0]> = {}): string {
    return renderToStaticMarkup(
      <SelfRelayEntry
        relay={{
          ...RELAY_MODE,
          mode: 'hub',
          relayMode: false,
          relays: [],
          ordered: [],
          attached: null,
        }}
        publicUrl="https://relay.example.com"
        highlight={false}
        onOpen={() => undefined}
        {...props}
      />
    );
  }

  test('一句陈述 + 一个 CTA，没有 Hub 的任何说法', () => {
    const html = entry();
    expect(html).toContain('data-testid="nodes-relay-self-entry"');
    expect(html).toContain('data-testid="nodes-relay-enroll-self"');
    expect(html).toContain('nodes.machine.relayServiceEnrollHint');
    expect(html).toContain('nodes.machine.relayServiceEnroll');
    expect(html).not.toContain('relay.tenant.actions.migrate');
    expect(html).not.toContain('relay.tenant.dialog.migrateNotice');
  });

  test('CTA 带着本机中继的公网地址：点下去就是预填好的那条', () => {
    expect(entry()).toContain('data-relay-url="https://relay.example.com"');
    // 地址还没配好时也不拦着：对话框里自己填
    expect(entry({ publicUrl: null })).toContain('data-relay-url=""');
  });

  test('刚设置完时高亮，平时是灰底', () => {
    expect(entry({ highlight: true })).toContain('bg-primary/10');
    expect(entry()).toContain('bg-muted/60');
  });

  test('旧节点没有这族路由时整块不出现', () => {
    expect(entry({ relay: { ...RELAY_MODE, unsupported: true } })).toBe('');
  });

  test('接上之后是链路面板的活，面板里没有这个 CTA', () => {
    expect(render()).not.toContain('data-testid="nodes-relay-self-entry"');
    expect(render()).not.toContain('data-testid="nodes-relay-enroll-self"');
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
      'nodes-relay-remove-a.example',
      'nodes-relay-remove-b.example',
    ]);
    rendered[2]?.props.onClick?.();
    expect(picked[0]?.url).toBe('https://b.example');
  });
});
