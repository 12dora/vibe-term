// 多中继形态的链路行：徽标取值、「设为主中继」的可点条件、两种形态的渲染分叉。
// 无 DOM 测试环境，渲染用 react-dom/server；未初始化 i18n 时 `t()` 原样返回 key。

import { describe, expect, test } from 'bun:test';
import type { RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  canSetPrimary,
  isMultiAttachView,
  relayPeersBadge,
  relayRoleBadge,
  relayRttBadge,
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
    // 单挂载那枚「在线 / 离线」状态徽标在这个版式里不再出现
    expect(html).not.toContain(`data-testid="nodes-relay-status-${HOST}"`);
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
    expect(html).toContain('text-amber-700');
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

  test('单条中继（或旧网关）时版式与今天一模一样', () => {
    const html = renderToStaticMarkup(
      <RelayRows relays={[row({ attached: true, rttMs: 42 })]} onSelect={() => undefined} />
    );
    expect(html).toContain(`data-testid="nodes-relay-status-${HOST}"`);
    expect(html).toContain('relay.tenant.strip.rtt');
    expect(html).not.toContain('nodes-relay-role-');
    expect(html).not.toContain('relay.tenant.switch.setPrimary');
  });
});
