import { describe, expect, test } from 'bun:test';
import type { NodeRow } from './merge-nodes';
import { buildNodeView } from './node-view-model';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function row(overrides: Partial<NodeRow> & { id: string }): NodeRow {
  return {
    runtimeNodeId: overrides.id,
    name: 'studio',
    publicKey: '',
    fingerprint: 'ffffffffffffffff',
    online: true,
    reach: 'lan',
    transport: 'dc',
    rttMs: null,
    version: '1.1.9',
    directCapable: false,
    loggedIn: true,
    inventory: null,
    isSelf: false,
    isHub: false,
    lastSeenAt: null,
    status: null,
    certificate: null,
    certSig: null,
    ...overrides,
  };
}

describe('buildNodeView', () => {
  test('在线已登录：ok + 组合状态 + 本地化 REACH + 地址', () => {
    const view = buildNodeView(row({ id: 'n1', address: 'office.lan' }), t, NOW);
    expect(view.statusTone).toBe('ok');
    expect(view.statusText).toBe('nodes.status.onlineSignedIn');
    expect(view.reachText).toBe('nodes.link.lanDc');
    expect(view.addressText).toBe('office.lan');
    expect(view.lastSeenText).toBe('—');
    expect(view.statusTitle).toBeUndefined();
  });

  test('在线未登录（非 self）', () => {
    const view = buildNodeView(row({ id: 'n2', loggedIn: false }), t, NOW);
    expect(view.statusTone).toBe('ok');
    expect(view.statusText).toBe('nodes.status.onlineSignedOut');
  });

  test('本机即使 loggedIn 为 false 也算已登录', () => {
    const view = buildNodeView(row({ id: 'me', isSelf: true, loggedIn: false }), t, NOW);
    expect(view.statusText).toBe('nodes.status.onlineSignedIn');
    expect(view.reachText).toBe('—');
  });

  test('离线带 lastSeen：muted + offlineSince，绝对时间在 title', () => {
    const at = NOW - 3 * HOUR;
    const view = buildNodeView(row({ id: 'off', online: false, lastSeenAt: at }), t, NOW);
    expect(view.statusTone).toBe('muted');
    expect(view.statusText).toContain('nodes.status.offlineSince');
    expect(view.statusText).toContain('nodes.time.hours');
    expect(view.lastSeenText).toBe('nodes.time.hours:{"n":3}');
    expect(view.statusTitle).toBe(new Date(at).toLocaleString());
    expect(view.reachText).toBe('—');
  });

  test('离线无 lastSeen', () => {
    const view = buildNodeView(row({ id: 'off', online: false }), t, NOW);
    expect(view.statusText).toBe('nodes.status.offline');
    expect(view.lastSeenText).toBe('—');
    expect(view.statusTitle).toBeUndefined();
  });

  test('待批准：warn + pending，REACH / 地址都是破折号', () => {
    const view = buildNodeView(row({ id: 'p', pending: true, address: 'x' }), t, NOW);
    expect(view.statusTone).toBe('warn');
    expect(view.statusText).toBe('nodes.status.pending');
    expect(view.reachText).toBe('—');
    expect(view.addressText).toBe('x');
  });

  test('地址缺省画破折号', () => {
    expect(buildNodeView(row({ id: 'n' }), t, NOW).addressText).toBe('—');
  });
});
