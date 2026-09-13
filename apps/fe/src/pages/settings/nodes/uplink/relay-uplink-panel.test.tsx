// 「连接」段的中继形态：一行「上级」摆链路，下面是提醒堆。操作全在卡片 ⋯ 菜单里（见
// `connect-menu.test.ts`）。无 DOM 测试环境，用 react-dom/server 静态渲染。

import { describe, expect, test } from 'bun:test';
import type { UseMeshRelayResult } from '@/node/mesh-relay';
import type { RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RelayActionsController } from '../relay/use-relay-actions';
import { RelayUplinkPanel } from './relay-uplink-panel';
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
  metaKeyLagging: [],
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
  resendToken: () => Promise.resolve(),
};

function render(props: Partial<Parameters<typeof RelayUplinkPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    <RelayUplinkPanel relay={RELAY_MODE} actions={IDLE_ACTIONS} {...props} />
  );
}

describe('中继链路与操作', () => {
  test('链路摆在「上级」那一行，操作一个都不留在卡面上', () => {
    const html = render();
    expect(html).toContain('data-testid="local-uplink-relay-panel"');
    expect(html).toContain('data-testid="nodes-relay-rows"');
    expect(html).toContain('nodes.machine.upstream');
    // 追加 / 更多 / 离开 / 「先离开中继」那句全部搬进卡片 ⋯ 菜单
    expect(html).not.toContain('data-testid="nodes-relay-add"');
    expect(html).not.toContain('data-testid="nodes-relay-menu"');
    expect(html).not.toContain('data-testid="nodes-relay-leave"');
    expect(html).not.toContain('data-testid="nodes-relay-leave-first"');
    expect(html).not.toContain('nodes.machine.relayLeaveFirst');
  });

  test('只有一条中继时链路行不可选；多条时非当前那条是可点的按钮', () => {
    expect(render()).not.toContain('data-testid="nodes-relay-switch-');
    const two = [link(), link({ url: 'https://b.example', attached: false, priority: 2 })];
    const html = render({ relay: { ...RELAY_MODE, relays: two, ordered: two } });
    expect(html).toContain('data-testid="nodes-relay-switch-b.example"');
    expect(html).toContain('aria-current="true"');
  });

  test('旧节点没有这族路由：只留链路行', () => {
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

describe('固定与自动优选那一行', () => {
  const TOKYO = link({ url: 'https://tokyo.example', attached: false, priority: 2 });
  function multi(overrides: Partial<UseMeshRelayResult> = {}): string {
    const relays = [link(), TOKYO];
    return render({
      relay: { ...RELAY_MODE, relays, ordered: relays, multiAttach: true, ...overrides },
    });
  }

  test('已固定：一句「自动优选暂停」加一个「取消固定」', () => {
    const html = multi({ preferredUrl: 'https://relay.example.com' });
    expect(html).toContain('data-relay-auto-select="pinned"');
    expect(html).toContain('relay.tenant.autoSelect.pinnedHint');
    expect(html).toContain('data-testid="nodes-relay-unpin"');
    expect(html).toContain('relay.tenant.autoSelect.unpin');
  });

  test('未固定且自动优选开着：只有一句陈述，没有按钮', () => {
    const html = multi({
      autoSelect: { enabled: true, lastSwitchAt: null, switchReason: null, nextEvalAt: null },
    });
    expect(html).toContain('data-relay-auto-select="auto"');
    expect(html).toContain('relay.tenant.autoSelect.on');
    expect(html).not.toContain('data-testid="nodes-relay-unpin"');
  });

  test('换过主的话带上「上次切换」的相对时间', () => {
    const html = multi({
      autoSelect: {
        enabled: true,
        lastSwitchAt: Date.now() - 3 * 60_000,
        switchReason: 'auto-rtt',
        nextEvalAt: null,
      },
    });
    expect(html).toContain('relay.tenant.autoSelect.lastSwitch');
  });

  test('自动优选没开、也没固定时整行不出', () => {
    expect(multi()).not.toContain('data-testid="nodes-relay-auto-select"');
  });

  test('单条中继不摆这一行：没什么可优选、也没什么可固定的', () => {
    const html = render({ relay: { ...RELAY_MODE, preferredUrl: 'https://relay.example.com' } });
    expect(html).not.toContain('data-testid="nodes-relay-auto-select"');
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

  test('本身是一条提醒：刚设置完时高亮，平时是灰底', () => {
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

  test('令牌换代：补一条「等待新令牌」，重新输入接入密码仍然可点', () => {
    const html = render({
      relay: { ...RELAY_MODE, kicked: true, awaitingToken: true },
    });
    expect(html).toContain('data-testid="nodes-relay-awaiting-token"');
    expect(html).toContain('relay.tenant.awaitingToken.notice');
    // 30 天悬崖必须和状态摆在一起：过了就只剩账号密码重新加入
    expect(html).toContain('relay.tenant.awaitingToken.hint');
    // 被踢的租户只能靠重新接入恢复（单节点租户更是只有本机能做），动作不能被藏起来
    expect(html).toContain('data-testid="nodes-relay-reauth"');
    expect(html).toContain('data-testid="nodes-relay-reauth-action"');
  });

  test('令牌换代：带一个「重发中继令牌」按钮，给错过换发的成员补一条 set-relays', () => {
    const html = render({ relay: { ...RELAY_MODE, awaitingToken: true } });
    expect(html).toContain('data-testid="nodes-relay-resend-token"');
    expect(html).toContain('relay.tenant.resendToken.action');
    expect(html).not.toContain('data-testid="nodes-relay-resend-token" disabled');
  });

  test('没有换代时不摆重发按钮：它会往密钥日志里塞一条无谓的记录', () => {
    expect(render()).not.toContain('data-testid="nodes-relay-resend-token"');
  });

  test('正在写别的记录时重发按钮禁用：key log 一次只允许一个写入者', () => {
    const html = render({
      relay: { ...RELAY_MODE, awaitingToken: true },
      actions: { ...IDLE_ACTIONS, busy: true },
    });
    expect(html).toMatch(/data-testid="nodes-relay-resend-token"[^>]*disabled/);
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
