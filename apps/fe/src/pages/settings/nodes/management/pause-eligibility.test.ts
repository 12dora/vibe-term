import { afterEach, describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import {
  eligiblePauseRows,
  eligibleResumeRows,
  forwarderNodeIdFromPath,
  isPauseEligible,
  pauseBlockReason,
  pauseBlockTitle,
} from './pause-eligibility';
import { beginPauseInflight, resetPauseInflightForTest } from './pause-inflight';

function row(overrides: Partial<NodeRow> & { id: string }): NodeRow {
  return {
    runtimeNodeId: overrides.id,
    name: overrides.id,
    publicKey: '',
    fingerprint: '',
    online: true,
    reach: 'lan',
    transport: null,
    rttMs: null,
    version: '1.2.0',
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

describe('pause eligibility', () => {
  afterEach(() => resetPauseInflightForTest());

  test('从 /n/:nodeId 路径取出当前转发节点；self 与无前缀不算', () => {
    expect(forwarderNodeIdFromPath('/n/abcd/settings')).toBe('abcd');
    expect(forwarderNodeIdFromPath('/n/self/settings')).toBeNull();
    expect(forwarderNodeIdFromPath('/settings')).toBeNull();
  });

  test('本机、待批准、Hub、当前转发节点都不能暂停', () => {
    expect(pauseBlockReason(row({ id: 'a', isSelf: true }), '/')).toBe('self');
    expect(pauseBlockReason(row({ id: 'a', pending: true }), '/')).toBe('pending');
    expect(pauseBlockReason(row({ id: 'a', isHub: true }), '/')).toBe('hub');
    expect(pauseBlockReason(row({ id: 'abcd' }), '/n/abcd/settings')).toBe('forwarder');
    expect(pauseBlockReason(row({ id: 'abcd' }), '/settings')).toBeNull();
  });

  test('恢复：本机与待批准仍不可；已暂停的 Hub / 当前转发节点可以恢复', () => {
    expect(pauseBlockReason(row({ id: 'a', isSelf: true }), '/', 'resume')).toBe('self');
    expect(pauseBlockReason(row({ id: 'a', pending: true }), '/', 'resume')).toBe('pending');
    expect(pauseBlockReason(row({ id: 'a', isHub: true }), '/', 'resume')).toBeNull();
    expect(pauseBlockReason(row({ id: 'abcd' }), '/n/abcd/settings', 'resume')).toBeNull();
    expect(isPauseEligible(row({ id: 'a', isHub: true }), '/', 'resume')).toBe(true);
  });

  test('禁用文案：本机 / Hub / 当前使用', () => {
    const t = (key: string) => key;
    expect(pauseBlockTitle('self', t)).toBe('nodes.pause.selfBlocked');
    expect(pauseBlockTitle('hub', t)).toBe('nodes.pause.hubBlocked');
    expect(pauseBlockTitle('forwarder', t)).toBe('nodes.pause.forwarderBlocked');
    expect(pauseBlockTitle('pending', t)).toBeUndefined();
    expect(pauseBlockTitle(null, t)).toBeUndefined();
  });

  test('批量暂停 / 恢复按资格与当前暂停态拆开', () => {
    const rows = [
      row({ id: 'ok' }),
      row({ id: 'paused', paused: true }),
      row({ id: 'hub', isHub: true }),
      row({ id: 'paused-hub', isHub: true, paused: true }),
      row({ id: 'fwd' }),
      row({ id: 'paused-fwd', paused: true }),
    ];
    expect(eligiblePauseRows(rows, '/n/fwd/settings').map((item) => item.id)).toEqual(['ok']);
    expect(eligibleResumeRows(rows, '/n/fwd/settings').map((item) => item.id)).toEqual([
      'paused',
      'paused-hub',
      'paused-fwd',
    ]);
    expect(isPauseEligible(row({ id: 'ok' }), '/')).toBe(true);
  });

  test('在途节点从暂停与恢复资格里剔除', () => {
    const rows = [row({ id: 'ok' }), row({ id: 'paused', paused: true })];
    beginPauseInflight('ok');
    beginPauseInflight('paused');
    expect(eligiblePauseRows(rows, '/').map((item) => item.id)).toEqual([]);
    expect(eligibleResumeRows(rows, '/').map((item) => item.id)).toEqual([]);
  });
});
