import { describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import {
  eligiblePauseRows,
  eligibleResumeRows,
  forwarderNodeIdFromPath,
  isPauseEligible,
  pauseBlockReason,
  pauseBlockTitle,
} from './pause-eligibility';

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
      row({ id: 'fwd' }),
    ];
    expect(eligiblePauseRows(rows, '/n/fwd/settings').map((item) => item.id)).toEqual(['ok']);
    expect(eligibleResumeRows(rows, '/n/fwd/settings').map((item) => item.id)).toEqual(['paused']);
    expect(isPauseEligible(row({ id: 'ok' }), '/')).toBe(true);
  });
});
