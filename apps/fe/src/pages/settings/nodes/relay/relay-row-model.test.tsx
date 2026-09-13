// 多中继形态的链路行：徽标取值、「设为主中继」的可点条件、两种形态的渲染分叉。
// 无 DOM 测试环境，渲染用 react-dom/server；未初始化 i18n 时 `t()` 原样返回 key。

import { describe, expect, test } from 'bun:test';
import type { RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  canSetPrimary,
  isMultiAttachView,
  relayAutoSelectState,
  relayPeersBadge,
  relayPinBadge,
  relayRoleBadge,
  relayRttBadge,
  relayScoreHint,
  relayTurnChip,
  turnEndpointLabel,
  turnProbeKey,
} from './relay-row-model';
import { RelayRows } from './relay-rows';

const HOST = 'sh.example.com:8443';

function row(overrides: Partial<RelayLinkStatus> = {}): RelayLinkStatus {
  return {
    url: 'https://sh.example.com:8443',
    priority: 1,
    online: true,
    attached: false,
    ...overrides,
  };
}

const TOKYO = row({
  url: 'https://tokyo.example.com:8443',
  priority: 2,
  role: 'secondary',
  rttMs: 38,
  peersOnline: 1,
});

describe('身份徽标', () => {
  test('主 / 副 / 未连接三态，主中继是实心徽标', () => {
    expect(relayRoleBadge(row({ role: 'primary' }))).toEqual({
      key: 'relay.tenant.strip.rolePrimary',
      variant: 'default',
    });
    expect(relayRoleBadge(row({ role: 'secondary' }))).toEqual({
      key: 'relay.tenant.strip.roleSecondary',
      variant: 'outline',
    });
    expect(relayRoleBadge(row({ role: null, online: false }))).toEqual({
      key: 'relay.tenant.strip.roleDetached',
      variant: 'outline',
    });
  });
});

describe('延迟与在线对端数', () => {
  test('每条连着的链路都有自己的延迟徽标，取整后展示', () => {
    expect(relayRttBadge(row({ rttMs: 12.4 }))).toEqual({
      key: 'relay.tenant.strip.rtt',
      params: { ms: 12 },
      variant: 'outline',
    });
  });

  test('没连上、或连着但还没出样本时不出延迟徽标', () => {
    expect(relayRttBadge(row({ online: false, rttMs: 12 }))).toBeNull();
    expect(relayRttBadge(row({ rttMs: null }))).toBeNull();
    expect(relayRttBadge(row())).toBeNull();
  });

  test('在线对端数为 0 也照出，未知才不出', () => {
    expect(relayPeersBadge(row({ peersOnline: 0 }))).toEqual({
      key: 'relay.tenant.strip.peersOnline',
      params: { n: 0 },
      variant: 'outline',
    });
    expect(relayPeersBadge(row())).toBeNull();
  });
});

describe('固定与自动优选', () => {
  test('固定优先于自动优选：固定期间自动优选是冻结的，不能同时宣称两件事', () => {
    expect(relayPinBadge(row({ role: 'primary', pinned: true, autoSelected: true }))).toEqual({
      key: 'relay.tenant.strip.pinned',
      variant: 'outline',
    });
    expect(relayPinBadge(row({ role: 'primary', autoSelected: true }))).toEqual({
      key: 'relay.tenant.strip.autoSelected',
      variant: 'outline',
    });
  });

  test('固定的那条即便不是主中继也照摆；「自动优选」只属于主中继', () => {
    expect(relayPinBadge(row({ role: 'secondary', pinned: true }))?.key).toBe(
      'relay.tenant.strip.pinned'
    );
    expect(relayPinBadge(row({ role: 'secondary', autoSelected: true }))).toBeNull();
  });

  test('旧网关两个字段都不下发时一枚都不出', () => {
    expect(relayPinBadge(row({ role: 'primary', attached: true }))).toBeNull();
  });

  test('打分取整、带「越小越好」的悬停解释；未连接或没有打分时不出', () => {
    expect(relayScoreHint(row({ score: 42.4 }))).toEqual({
      key: 'relay.tenant.strip.score',
      params: { ms: 42 },
      titleKey: 'relay.tenant.strip.scoreTitle',
    });
    expect(relayScoreHint(row({ online: false, score: 42 }))).toBeNull();
    expect(relayScoreHint(row({ score: null }))).toBeNull();
    expect(relayScoreHint(row({ score: Number.NaN }))).toBeNull();
    expect(relayScoreHint(row())).toBeNull();
  });

  test('卡片那一行：固定优先、其次自动优选、都没有就整行不出', () => {
    expect(
      relayAutoSelectState({
        preferredUrl: 'https://sh.example',
        autoSelect: { enabled: true, lastSwitchAt: 5, switchReason: 'manual', nextEvalAt: null },
      })
    ).toEqual({
      kind: 'pinned',
      hintKey: 'relay.tenant.autoSelect.pinnedHint',
      lastSwitchAt: null,
    });
    expect(
      relayAutoSelectState({
        preferredUrl: null,
        autoSelect: { enabled: true, lastSwitchAt: 5, switchReason: 'auto-rtt', nextEvalAt: 9 },
      })
    ).toEqual({ kind: 'auto', hintKey: 'relay.tenant.autoSelect.on', lastSwitchAt: 5 });
    expect(
      relayAutoSelectState({
        autoSelect: { enabled: false, lastSwitchAt: null, switchReason: null, nextEvalAt: null },
      })
    ).toEqual({ kind: 'none', hintKey: null, lastSwitchAt: null });
    expect(relayAutoSelectState({})).toMatchObject({ kind: 'none' });
  });

  test('从未自动换过主时不给「上次切换」', () => {
    expect(
      relayAutoSelectState({
        autoSelect: { enabled: true, lastSwitchAt: null, switchReason: null, nextEvalAt: null },
      }).lastSwitchAt
    ).toBeNull();
  });
});

describe('TURN 挂件', () => {
  test('地址去掉协议与查询串，探测结论三态各有 key', () => {
    expect(turnEndpointLabel('turn:sh.example.com:3478?transport=udp')).toBe('sh.example.com:3478');
    expect(turnEndpointLabel('turns:sh.example.com:5349')).toBe('sh.example.com:5349');
    expect(turnEndpointLabel('绝不是地址')).toBe('绝不是地址');
    expect(turnProbeKey(true)).toBe('relay.tenant.strip.turnReachable');
    expect(turnProbeKey(false)).toBe('relay.tenant.strip.turnUnreachable');
    expect(turnProbeKey(null)).toBe('relay.tenant.strip.turnUnprobed');
  });

  test('没有 TURN 时整个挂件不出', () => {
    expect(relayTurnChip(row())).toBeNull();
    expect(relayTurnChip(row({ turn: { url: 'turn:a:3478', probeOk: false } }))).toEqual({
      endpoint: 'a:3478',
      verdictKey: 'relay.tenant.strip.turnUnreachable',
      reachable: false,
      tone: 'destructive',
    });
  });

  test('本机可达时带 N/M 节点；失败时带 N/M 节点可达并按舰队改色', () => {
    expect(
      relayTurnChip(
        row({
          turn: {
            url: 'turn:a:3478',
            probeOk: true,
            members: { ok: 5, total: 5, updatedAt: 1 },
          },
        })
      )
    ).toEqual({
      endpoint: 'a:3478',
      verdictKey: 'relay.tenant.strip.turnReachable',
      membersKey: 'relay.tenant.strip.turnMembersCount',
      membersParams: { ok: 5, total: 5 },
      reachable: true,
      tone: 'default',
    });
    expect(
      relayTurnChip(
        row({
          turn: {
            url: 'turn:a:3478',
            probeOk: false,
            members: { ok: 4, total: 5, updatedAt: 1 },
            localHint: 'tun',
          },
        })
      )
    ).toMatchObject({
      verdictKey: 'relay.tenant.strip.turnUnreachable',
      membersKey: 'relay.tenant.strip.turnMembersReachable',
      membersParams: { ok: 4, total: 5 },
      tone: 'warning',
      titleKey: 'relay.tenant.strip.turnTunHint',
    });
    expect(
      relayTurnChip(
        row({
          turn: {
            url: 'turn:a:3478',
            probeOk: false,
            members: { ok: 0, total: 3, updatedAt: 1 },
          },
        })
      )?.tone
    ).toBe('destructive');
  });
});

describe('「设为主中继」可点的条件', () => {
  test('主中继自己、被踢的、没连上的都不给点', () => {
    expect(canSetPrimary(row({ role: 'primary' }))).toBe(false);
    expect(canSetPrimary(row({ role: 'secondary', kicked: true }))).toBe(false);
    expect(canSetPrimary(row({ role: null, online: false }))).toBe(false);
    expect(canSetPrimary(row({ role: 'secondary' }))).toBe(true);
  });
});

describe('两种形态的分叉', () => {
  test('只有网关明说多挂载、且确实多于一条时才换版式', () => {
    expect(isMultiAttachView(true, [1, 2])).toBe(true);
    expect(isMultiAttachView(true, [1])).toBe(false);
    expect(isMultiAttachView(false, [1, 2])).toBe(false);
    expect(isMultiAttachView(undefined, [1, 2])).toBe(false);
  });

  test('多挂载：每行各自摆身份 / 延迟 / 在线数 / TURN，行不再是单选', () => {
    const html = renderToStaticMarkup(
      <RelayRows
        multiAttach
        onSelect={() => undefined}
        relays={[
          row({
            role: 'primary',
            attached: true,
            rttMs: 12,
            peersOnline: 2,
            turn: { url: 'turn:sh.example.com:3478?transport=udp', probeOk: true },
          }),
          TOKYO,
        ]}
      />
    );
    expect(html).toContain(`data-testid="nodes-relay-role-${HOST}"`);
    expect(html).toContain('relay.tenant.strip.rolePrimary');
    expect(html).toContain('relay.tenant.strip.roleSecondary');
    expect(html).toContain(`data-testid="nodes-relay-rtt-${HOST}"`);
    expect(html).toContain('data-testid="nodes-relay-rtt-tokyo.example.com:8443"');
    expect(html).toContain(`data-testid="nodes-relay-peers-${HOST}"`);
    expect(html).toContain(`data-testid="nodes-relay-turn-${HOST}"`);
    expect(html).toContain('sh.example.com:3478');
    expect(html).toContain('relay.tenant.strip.turnReachable');
    // 事实之间只用 `·` 分隔，不再是一排徽标
    expect(html).not.toContain('data-slot="badge"');
  });

  test('多挂载：主中继摆「自动优选」，各行的打分跟在延迟后面', () => {
    const html = renderToStaticMarkup(
      <RelayRows
        multiAttach
        relays={[
          row({ role: 'primary', attached: true, autoSelected: true, rttMs: 12, score: 18 }),
          { ...TOKYO, score: 55.6 },
        ]}
      />
    );
    expect(html).toContain(`data-testid="nodes-relay-pin-${HOST}"`);
    expect(html).toContain('relay.tenant.strip.autoSelected');
    expect(html).toContain(`data-testid="nodes-relay-score-${HOST}"`);
    expect(html).toContain('data-testid="nodes-relay-score-tokyo.example.com:8443"');
    expect(html).toContain('title="relay.tenant.strip.scoreTitle"');
    expect(html).toContain('relay.tenant.strip.score');
  });

  test('多挂载：固定的那条摆「已固定」，没有固定也没有优选时一枚都不出', () => {
    const pinned = renderToStaticMarkup(
      <RelayRows
        multiAttach
        relays={[row({ role: 'primary', attached: true, pinned: true }), TOKYO]}
      />
    );
    expect(pinned).toContain('relay.tenant.strip.pinned');
    expect(pinned).not.toContain('relay.tenant.strip.autoSelected');
    const plain = renderToStaticMarkup(
      <RelayRows multiAttach relays={[row({ role: 'primary', attached: true }), TOKYO]} />
    );
    expect(plain).not.toContain('data-testid="nodes-relay-pin-');
    expect(plain).not.toContain('data-testid="nodes-relay-score-');
  });

  test('多挂载：本机 TURN 失败时展示舰队 tally 与 TUN tooltip', () => {
    const html = renderToStaticMarkup(
      <RelayRows
        multiAttach
        relays={[
          row({
            role: 'primary',
            attached: true,
            turn: {
              url: 'turn:sh.example.com:3478',
              probeOk: false,
              members: { ok: 4, total: 5, updatedAt: 1 },
              localHint: 'tun',
            },
          }),
          TOKYO,
        ]}
      />
    );
    expect(html).toContain('relay.tenant.strip.turnUnreachable');
    expect(html).toContain('relay.tenant.strip.turnMembersReachable');
    expect(html).toContain('title="relay.tenant.strip.turnTunHint"');
    expect(html).toContain('text-amber-600');
  });

  test('多挂载：主中继那行的按钮禁用，副中继可点', () => {
    const html = renderToStaticMarkup(
      <RelayRows
        multiAttach
        onSelect={() => undefined}
        relays={[row({ role: 'primary', attached: true }), TOKYO]}
      />
    );
    const primary = html.slice(html.indexOf(`nodes-relay-switch-${HOST}`) - 200);
    expect(primary).toContain('disabled');
    expect(html).toContain('data-testid="nodes-relay-switch-tokyo.example.com:8443"');
    expect(html).toContain('relay.tenant.switch.setPrimary');
  });

  test('没传 onSelect 时不摆按钮，链路信息照旧', () => {
    const html = renderToStaticMarkup(
      <RelayRows multiAttach relays={[row({ role: 'primary', attached: true }), TOKYO]} />
    );
    expect(html).not.toContain('nodes-relay-switch-');
    expect(html).toContain('relay.tenant.strip.rolePrimary');
  });

  test('单条中继（或旧网关）：只剩状态点与主机名', () => {
    const html = renderToStaticMarkup(
      <RelayRows relays={[row({ attached: true, rttMs: 42 })]} onSelect={() => undefined} />
    );
    expect(html).toContain(`data-testid="nodes-relay-status-${HOST}"`);
    expect(html).toContain(`data-testid="nodes-relay-host-${HOST}"`);
    expect(html).not.toContain('relay.tenant.strip.rtt');
    expect(html).not.toContain('nodes-relay-role-');
    expect(html).not.toContain('relay.tenant.switch.setPrimary');
  });
});
