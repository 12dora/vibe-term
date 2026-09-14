// 本机卡上的 TURN 一行。无 DOM 测试环境，渲染用 react-dom/server；未初始化 i18n 时
// `t()` 原样返回 key。

import { describe, expect, test } from 'bun:test';
import type { LocalRelayTurnStatus } from '@vibeterm/api-client/local/types';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RelayTurnStatus } from '../../relay/relay-turn-model';
import { RelayTurnRow } from './relay-turn-row';

function turn(overrides: Partial<RelayTurnStatus> = {}): RelayTurnStatus {
  return {
    enabled: true,
    source: 'builtin' as LocalRelayTurnStatus['source'],
    url: 'turn:relay.example.com:40000?transport=udp',
    port: 40000,
    externalIp: '1.2.3.4',
    listening: true,
    allocations: 2,
    error: null,
    relayPortRange: '40001-40049',
    membersProbe: { ok: 3, total: 3, updatedAt: 1 },
    ...overrides,
  };
}

function render(overrides: Partial<RelayTurnStatus> = {}): string {
  return renderToStaticMarkup(<RelayTurnRow turn={turn(overrides)} />);
}

describe('TURN 一行', () => {
  test('状态 · 来源 · 地址 · 外网 IP 串成一句，成员探测跟在后面', () => {
    const html = render();
    expect(html).toContain('data-testid="relay-turn"');
    expect(html).toContain('relay.admin.turn.title');
    const line = html.slice(html.indexOf('data-testid="relay-turn"'));
    expect(line).toContain('relay.admin.turn.stateListening');
    expect(line).toContain('relay.admin.turn.sourceBuiltin');
    expect(line).toContain('turn:relay.example.com:40000');
    expect(line).toContain('relay.admin.turn.externalIp');
    expect(html).toContain('data-testid="relay-turn-members-probe"');
    expect(html).toContain('relay.admin.turn.membersProbe');
  });

  test('端口放行那句不再出现：端口由「网络」段的端口行负责', () => {
    expect(render()).not.toContain('relay.admin.turn.firewall');
  });

  test('磁贴那一套（StatTile / 分配数 / 用途说明）一个都不带', () => {
    const html = render();
    expect(html).not.toContain('data-testid="relay-metric-turn"');
    expect(html).not.toContain('relay.admin.turn.hint');
    expect(html).not.toContain('relay.admin.turn.sub');
  });

  test('关闭时说「已关闭」，不摆地址', () => {
    const html = render({ enabled: false, source: 'off', url: null, externalIp: null });
    expect(html).toContain('relay.admin.turn.stateOff');
    expect(html).toContain('relay.admin.turn.sourceOff');
    expect(html).not.toContain('turn:relay.example.com');
  });

  test('报错另起一行红字', () => {
    const html = render({ error: 'bind EADDRINUSE' });
    expect(html).toContain('data-testid="relay-turn-error"');
    expect(html).toContain('relay.admin.turn.failed');
    expect(html).toContain('text-destructive');
  });

  test('成员探测部分失败时那一截变黄，全失败变红', () => {
    expect(render({ membersProbe: { ok: 1, total: 3, updatedAt: 1 } })).toContain('text-amber-600');
    expect(render({ membersProbe: { ok: 0, total: 3, updatedAt: 1 } })).toContain(
      'text-destructive'
    );
  });

  test('旧中继不下发成员探测时那一截不出', () => {
    expect(render({ membersProbe: null })).not.toContain('data-testid="relay-turn-members-probe"');
  });
});
