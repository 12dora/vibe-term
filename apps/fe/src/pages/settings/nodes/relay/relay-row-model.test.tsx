// 多中继形态的链路行：徽标取值、「设为主中继」的可点条件、两种形态的渲染分叉。
// 无 DOM 测试环境，渲染用 react-dom/server；未初始化 i18n 时 `t()` 原样返回 key。

import { describe, expect, test } from 'bun:test';
import type { RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  canSetPrimary,
  isMultiAttachView,
  relayAutoSelectState,
  relayMoreTipLines,
  relayPathBestLine,
  relayPeersBadge,
  relayPinBadge,
  relayRoleBadge,
  relayRttBadge,
  relayScoreHint,
  relayTurnChip,
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
      key: 'relay.tenant.strip.tip.peers',
      params: { n: 0, count: 0 },
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

  test('优选指数取整、不带 ms；未连接或没有打分时不出', () => {
    expect(relayScoreHint(row({ score: 42.4 }))).toEqual({
      key: 'relay.tenant.strip.tip.score',
      params: { value: 42 },
    });
    expect(relayScoreHint(row({ online: false, score: 42 }))).toBeNull();
    expect(relayScoreHint(row({ score: null }))).toBeNull();
    expect(relayScoreHint(row({ score: Number.NaN }))).toBeNull();
    expect(relayScoreHint(row())).toBeNull();
  });

  const AUTO_OFF = {
    enabled: false,
    lastSwitchAt: null,
    switchReason: null,
    nextEvalAt: null,
  } as const;

  test('卡片那一行：固定优先、其次自动优选、都没有就整行不出', () => {
    expect(
      relayAutoSelectState({
        preferredUrl: 'https://sh.example',
        autoSelect: { enabled: true, lastSwitchAt: 5, switchReason: 'manual', nextEvalAt: null },
      })
    ).toEqual({
      kind: 'pinned',
      hintKey: 'relay.tenant.autoSelect.pinnedHint',
      unpinDoneKey: 'relay.tenant.autoSelect.unpinDone',
      lastSwitchAt: null,
    });
    expect(
      relayAutoSelectState({
        preferredUrl: null,
        autoSelect: { enabled: true, lastSwitchAt: 5, switchReason: 'auto-rtt', nextEvalAt: 9 },
      })
    ).toEqual({
      kind: 'auto',
      hintKey: 'relay.tenant.autoSelect.on',
      unpinDoneKey: null,
      lastSwitchAt: 5,
    });
    expect(relayAutoSelectState({ preferredUrl: null, autoSelect: AUTO_OFF })).toEqual({
      kind: 'none',
      hintKey: null,
      unpinDoneKey: null,
      lastSwitchAt: null,
    });
  });

  // 自动优选被配置关掉时网关仍会下发 preferredUrl：说「暂停 / 恢复」是反的，它压根没开过。
  test('自动优选没开时固定态另说一句，取消固定的提示也另一条', () => {
    expect(
      relayAutoSelectState({ preferredUrl: 'https://sh.example', autoSelect: AUTO_OFF })
    ).toEqual({
      kind: 'pinned',
      hintKey: 'relay.tenant.autoSelect.pinnedHintAutoOff',
      unpinDoneKey: 'relay.tenant.autoSelect.unpinDoneAutoOff',
      lastSwitchAt: null,
    });
  });

  // 网关的 noteAttached 在任何一次 attach（含 startup）都会写 lastSwitchAt。
  test('只有自动换主（auto-rtt / auto-failover）才算「上次切换」', () => {
    const at = (switchReason: 'startup' | 'manual' | 'auto-rtt' | 'auto-failover' | null) =>
      relayAutoSelectState({
        preferredUrl: null,
        autoSelect: { enabled: true, lastSwitchAt: 5, switchReason, nextEvalAt: null },
      }).lastSwitchAt;
    expect(at('auto-rtt')).toBe(5);
    expect(at('auto-failover')).toBe(5);
    expect(at('startup')).toBeNull();
    expect(at('manual')).toBeNull();
    expect(at(null)).toBeNull();
  });
});

describe('TURN 挂件', () => {
  test('探测结论三态各有 key；endpoint 剥掉查询串保留 turn:host:port', () => {
    expect(turnProbeKey(true)).toBe('relay.tenant.strip.turnReachable');
    expect(turnProbeKey(false)).toBe('relay.tenant.strip.turnUnreachable');
    expect(turnProbeKey(null)).toBe('relay.tenant.strip.turnUnprobed');
    expect(
      relayTurnChip(row({ turn: { url: 'turn:a:3478?transport=udp', probeOk: true } }))?.endpoint
    ).toBe('turn:a:3478');
  });

  test('没有 TURN 时整个挂件不出', () => {
    expect(relayTurnChip(row())).toBeNull();
    expect(relayTurnChip(row({ turn: { url: 'turn:a:3478', probeOk: false } }))).toEqual({
      endpoint: 'turn:a:3478',
      verdictKey: 'relay.tenant.strip.turnUnreachable',
      tone: 'destructive',
    });
  });

  test('成员探测用同一条文案；失败时按舰队改色，TUN 提示另起一行', () => {
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
      endpoint: 'turn:a:3478',
      verdictKey: 'relay.tenant.strip.turnReachable',
      membersKey: 'relay.tenant.strip.tip.turnMembers',
      membersParams: { ok: 5, total: 5 },
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
      membersKey: 'relay.tenant.strip.tip.turnMembers',
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

  test('多挂载：每行默认只摆身份 / 延迟 / 更多，行不再是单选', () => {
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
    expect(html).toContain(`data-testid="nodes-relay-more-${HOST}"`);
    expect(html).toContain('relay.tenant.strip.more');
    expect(html).toContain(`data-testid="nodes-relay-more-tip-${HOST}"`);
    expect(html).toContain(`data-testid="nodes-relay-peers-${HOST}"`);
    expect(html).toContain(`data-testid="nodes-relay-turn-${HOST}"`);
    expect(html).toContain('relay.tenant.strip.tip.turn');
    expect(html).not.toContain('data-slot="badge"');
  });

  test('多挂载：优选指数与固定态收进「更多」，不跟在延迟后面', () => {
    const html = renderToStaticMarkup(
      <RelayRows
        multiAttach
        relays={[
          row({ role: 'primary', attached: true, autoSelected: true, rttMs: 12, score: 18 }),
          { ...TOKYO, score: 55.6 },
        ]}
      />
    );
    expect(html).toContain(`data-testid="nodes-relay-more-${HOST}"`);
    expect(html).toContain(`data-testid="nodes-relay-pin-${HOST}"`);
    expect(html).toContain('relay.tenant.strip.autoSelected');
    expect(html).toContain(`data-testid="nodes-relay-score-${HOST}"`);
    expect(html).toContain('data-testid="nodes-relay-score-tokyo.example.com:8443"');
    expect(html).toContain('relay.tenant.strip.tip.score');
    expect(html).not.toContain('relay.tenant.strip.scoreTitle');
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

  test('多挂载：本机 TURN 失败时「更多」里展示舰队 tally 与 TUN 提示', () => {
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
    expect(html).toContain(`data-testid="nodes-relay-more-tip-${HOST}"`);
    expect(html).toContain('relay.tenant.strip.tip.turn');
    expect(html).toContain('relay.tenant.strip.tip.turnMembers');
    expect(html).toContain('relay.tenant.strip.turnTunHint');
    expect(html).toContain('text-amber-300');
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

  test('单条中继：状态点、主机名、身份徽标与延迟', () => {
    const html = renderToStaticMarkup(
      <RelayRows
        relays={[row({ attached: true, role: 'primary', rttMs: 42 })]}
        onSelect={() => undefined}
      />
    );
    expect(html).toContain(`data-testid="nodes-relay-status-${HOST}"`);
    expect(html).toContain(`data-testid="nodes-relay-host-${HOST}"`);
    expect(html).toContain(`data-testid="nodes-relay-role-${HOST}"`);
    expect(html).toContain('relay.tenant.strip.rolePrimary');
    expect(html).toContain(`data-testid="nodes-relay-rtt-${HOST}"`);
    expect(html).toContain('relay.tenant.strip.rtt');
    expect(html).not.toContain('relay.tenant.switch.setPrimary');
  });

  test('单条中继：有额外事实时出「更多」，没有则不出', () => {
    const withScore = renderToStaticMarkup(
      <RelayRows relays={[row({ attached: true, score: 18 })]} />
    );
    expect(withScore).toContain(`data-testid="nodes-relay-more-${HOST}"`);
    expect(withScore).toContain('relay.tenant.strip.tip.score');
    const plain = renderToStaticMarkup(<RelayRows relays={[row({ attached: true })]} />);
    expect(plain).not.toContain(`data-testid="nodes-relay-more-${HOST}"`);
  });
});

describe('「更多」气泡的行', () => {
  test('有数据才出：优选指数、对端、TURN、路径、固定态', () => {
    const lines = relayMoreTipLines(
      row({
        score: 18.2,
        peersOnline: 3,
        pathBestMs: 41.6,
        pinned: true,
        turn: {
          url: 'turn:a:3478',
          probeOk: true,
          members: { ok: 2, total: 3, updatedAt: 1 },
        },
      }),
      HOST
    );
    expect(lines.map((line) => line.key)).toEqual([
      'score',
      'peers',
      'turn',
      'turnMembers',
      'path',
      'pin',
    ]);
    expect(lines[0]?.params).toEqual({ value: 18 });
    expect(lines[2]?.params).toEqual({ endpoint: 'turn:a:3478' });
    expect(lines[2]?.translatedParams).toEqual({ state: 'relay.tenant.strip.turnReachable' });
    expect(relayPathBestLine(row({ pathBestMs: 41.6 }))?.params).toEqual({ ms: 42 });
    expect(relayPathBestLine(row())).toBeNull();
  });

  test('离线行在「更多」里只补「未连接」（错误行在卡片上）', () => {
    const lines = relayMoreTipLines(row({ online: false, lastErrorCode: 'dns', role: null }), HOST);
    expect(lines.map((line) => line.key)).toEqual(['role']);
    expect(lines[0]?.i18nKey).toBe('relay.tenant.strip.roleDetached');
  });
});
