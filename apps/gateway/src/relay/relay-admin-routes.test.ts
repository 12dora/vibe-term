import { afterEach, describe, expect, test } from 'bun:test';
import { ingestTurnOk, resetPortReachForTest } from '../mesh/port-reach';
import { withMembersProbe } from './relay-admin-routes';
import { EMPTY_RELAY_TURN_STATUS } from './relay-turn-config';

const SELF = 'https://self.example';
const OTHER = 'https://other.example';
const PEER = 'cc'.repeat(16);

describe('withMembersProbe', () => {
  afterEach(() => {
    resetPortReachForTest();
  });

  test('传入本机公网 URL 时只统计该中继的 TURN 报告', () => {
    ingestTurnOk(PEER, true, SELF);
    ingestTurnOk('dd'.repeat(16), false, OTHER);
    const scoped = withMembersProbe(EMPTY_RELAY_TURN_STATUS, SELF);
    expect(scoped.membersProbe).toMatchObject({ ok: 1, total: 1 });
    const other = withMembersProbe(EMPTY_RELAY_TURN_STATUS, OTHER);
    expect(other.membersProbe).toMatchObject({ ok: 0, total: 1 });
  });

  test('没有报告时不挂 membersProbe', () => {
    expect(withMembersProbe(EMPTY_RELAY_TURN_STATUS, SELF).membersProbe).toBeUndefined();
  });
});
