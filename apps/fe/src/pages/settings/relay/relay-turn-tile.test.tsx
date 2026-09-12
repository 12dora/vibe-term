// 中继内置 TURN：状态归一化、磁贴取值与明细行。
// 无 DOM 测试环境，渲染用 react-dom/server；未初始化 i18n 时 `t()` 原样返回 key。

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type RelayTurnStatus,
  relayTurnStatusOf,
  relayTurnView,
  turnEndpointText,
} from './relay-turn-model';
import { RelayTurnTile } from './relay-turn-tile';

function status(overrides: Partial<RelayTurnStatus> = {}): RelayTurnStatus {
  return {
    enabled: true,
    source: 'builtin',
    url: 'turn:sh.example.com:3478?transport=udp',
    port: 3478,
    externalIp: '203.0.113.7',
    listening: true,
    allocations: 2,
    error: null,
    relayPortRange: '49160-49259',
    ...overrides,
  };
}

describe('relayTurnStatusOf', () => {
  test('旧中继不下发这一段：整块不出现', () => {
    expect(relayTurnStatusOf(undefined)).toBeNull();
    expect(relayTurnStatusOf(null)).toBeNull();
    expect(relayTurnStatusOf({})).toBeNull();
    expect(relayTurnStatusOf({ source: 'whatever' })).toBeNull();
  });

  test('各字段按类型归一：畸形值退成「未知」而不是零值', () => {
    expect(
      relayTurnStatusOf({
        enabled: true,
        source: 'off',
        url: '',
        port: 0,
        externalIp: null,
        listening: 'yes',
        allocations: -3,
        error: '',
        relayPortRange: null,
      })
    ).toEqual({
      enabled: true,
      source: 'off',
      url: null,
      port: null,
      externalIp: null,
      listening: false,
      allocations: 0,
      error: null,
      relayPortRange: null,
    });
  });
});

describe('relayTurnView', () => {
  test('内置且在听：实心色调，分配数上屏，两个端口段都进放行提示', () => {
    const view = relayTurnView(status());
    expect(view).toEqual({
      modeKey: 'relay.admin.turn.sourceBuiltin',
      stateKey: 'relay.admin.turn.stateListening',
      tone: 'default',
      allocations: 2,
      endpoint: 'turn:sh.example.com:3478',
      externalIp: '203.0.113.7',
      error: null,
      firewall: { port: 3478, range: '49160-49259' },
    });
  });

  test('起了却没在听：黄色提醒', () => {
    const view = relayTurnView(status({ listening: false }));
    expect(view.tone).toBe('warning');
    expect(view.stateKey).toBe('relay.admin.turn.stateStopped');
  });

  test('关闭时不摆分配数，也不提放行端口', () => {
    const view = relayTurnView(
      status({ enabled: false, source: 'off', listening: false, allocations: 0 })
    );
    expect(view.allocations).toBeNull();
    expect(view.tone).toBe('muted');
    expect(view.stateKey).toBe('relay.admin.turn.stateOff');
    expect(view.firewall).toBeNull();
  });

  test('外部 TURN 的端口不归这台机器管，不出放行提示', () => {
    expect(relayTurnView(status({ source: 'external' })).firewall).toBeNull();
  });

  test('端口段缺一半时宁可不提示：只放行 3478 反而误导', () => {
    expect(relayTurnView(status({ relayPortRange: null })).firewall).toBeNull();
    expect(relayTurnView(status({ port: null })).firewall).toBeNull();
  });

  test('有报错时压过一切色调', () => {
    const view = relayTurnView(status({ error: 'EADDRINUSE' }));
    expect(view.tone).toBe('destructive');
    expect(view.error).toBe('EADDRINUSE');
  });

  test('地址去掉查询串', () => {
    expect(turnEndpointText('turn:a:3478?transport=udp')).toBe('turn:a:3478');
    expect(turnEndpointText('turn:a:3478')).toBe('turn:a:3478');
  });
});

describe('RelayTurnTile', () => {
  test('首次加载先摆骨架，与相邻磁贴同一档', () => {
    const html = renderToStaticMarkup(<RelayTurnTile turn={null} loading />);
    expect(html).toContain('data-testid="relay-turn-skeleton"');
  });

  test('旧中继不下发时整块不出现', () => {
    expect(renderToStaticMarkup(<RelayTurnTile turn={undefined} />)).toBe('');
  });

  test('地址、外网地址、放行提示各占一行', () => {
    const html = renderToStaticMarkup(<RelayTurnTile turn={status()} />);
    expect(html).toContain('data-testid="relay-metric-turn"');
    expect(html).toContain('turn:sh.example.com:3478');
    expect(html).toContain('relay.admin.turn.externalIp');
    expect(html).toContain('data-testid="relay-turn-firewall"');
    expect(html).not.toContain('data-testid="relay-turn-error"');
  });

  test('报错时多出一行红字', () => {
    const html = renderToStaticMarkup(
      <RelayTurnTile turn={status({ error: 'EADDRINUSE', listening: false })} />
    );
    expect(html).toContain('data-testid="relay-turn-error"');
    expect(html).toContain('relay.admin.turn.failed');
  });
});
