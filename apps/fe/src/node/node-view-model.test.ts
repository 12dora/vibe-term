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

describe('buildNodeView 的链路事实', () => {
  test('登录败在传输层：状态列改说「连接不上」，不给 signedOut 的登录入口', () => {
    const view = buildNodeView(row({ id: 'n3', loggedIn: false }), t, NOW, {
      failureCode: 'NODE_UNREACHABLE',
    });
    expect(view.statusText).toBe('nodes.status.unreachable');
    expect(view.statusTone).toBe('warn');
    expect(view.signInState).toBe('unreachable');
  });

  test('REST 正在退避：同一档，哪怕列表还报着已登录', () => {
    const view = buildNodeView(row({ id: 'n4' }), t, NOW, { unreachable: true });
    expect(view.statusText).toBe('nodes.status.unreachable');
    expect(view.signInState).toBe('unreachable');
  });

  test('凭证类失败仍是「在线 · 未登录」，登录入口照常出', () => {
    const view = buildNodeView(row({ id: 'n5', loggedIn: false }), t, NOW, {
      failureCode: 'NO_SESSION_KEY',
    });
    expect(view.statusText).toBe('nodes.status.onlineSignedOut');
    expect(view.signInState).toBe('signedOut');
  });

  test('没有链路事实时与旧口径完全一致', () => {
    expect(buildNodeView(row({ id: 'n6' }), t, NOW).signInState).toBe('ready');
    expect(buildNodeView(row({ id: 'n7', loggedIn: false }), t, NOW).signInState).toBe('signedOut');
    expect(buildNodeView(row({ id: 'n8', online: false }), t, NOW).signInState).toBe('offline');
  });
});

describe('signInRetrying：界面要不要给「重试连接」出口', () => {
  test('登录退避还排着：系统会自己再试，不催用户动手', () => {
    const view = buildNodeView(row({ id: 'r1', loggedIn: false }), t, NOW, {
      failureCode: 'NODE_UNREACHABLE',
      retrying: true,
    });
    expect(view.signInState).toBe('unreachable');
    expect(view.signInRetrying).toBe(true);
  });

  test('重试额度用完：必须给出口', () => {
    const view = buildNodeView(row({ id: 'r2', loggedIn: false }), t, NOW, {
      failureCode: 'NODE_UNREACHABLE',
      retrying: false,
    });
    expect(view.signInState).toBe('unreachable');
    expect(view.signInRetrying).toBe(false);
  });

  test('REST 退避窗口本身也算「还会再问一次」：那 2–5 秒不摆按钮', () => {
    const view = buildNodeView(row({ id: 'r3' }), t, NOW, { unreachable: true });
    expect(view.signInState).toBe('unreachable');
    expect(view.signInRetrying).toBe(true);
  });

  test('没有任何故障证据时恒为 false，但那时 signInState 也不是 unreachable', () => {
    const view = buildNodeView(row({ id: 'r4' }), t, NOW);
    expect(view.signInState).toBe('ready');
    expect(view.signInRetrying).toBe(false);
  });
});

describe('本机不受链路事实影响', () => {
  test('留在记账里的失败码不该把本机画成「连接不上」', () => {
    const view = buildNodeView(row({ id: 'me', isSelf: true, loggedIn: false }), t, NOW, {
      failureCode: 'NODE_UNREACHABLE',
      unreachable: true,
    });
    expect(view.signInState).toBe('ready');
    expect(view.statusText).toBe('nodes.status.onlineSignedIn');
  });

  test('本机离线仍按离线报', () => {
    const view = buildNodeView(row({ id: 'me', isSelf: true, online: false }), t, NOW, {
      failureCode: 'NODE_UNREACHABLE',
    });
    expect(view.signInState).toBe('offline');
  });
});
