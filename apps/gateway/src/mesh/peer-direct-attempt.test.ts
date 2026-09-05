import { describe, expect, test } from 'bun:test';
import {
  clearedDirectAttempt,
  directFailureView,
  emptyDirectAttempt,
  noteDcOutcome,
  noteWsOutcome,
} from './peer-direct-attempt';

describe('peer-direct-attempt', () => {
  test('a new attempt does not inherit fields from a previous record', () => {
    const prev = emptyDirectAttempt(10);
    noteDcOutcome(prev, 'direct_capable=false', 'not_direct_capable');
    noteWsOutcome(prev, 'refused ws://127.0.0.1:1/peer', ['ws://127.0.0.1:1/peer'], 'refused');
    const next = emptyDirectAttempt(20);
    noteWsOutcome(next, 'timeout ws://127.0.0.1:2/peer', ['ws://127.0.0.1:2/peer'], 'timeout', {
      url: 'ws://127.0.0.1:2/peer',
    });
    noteDcOutcome(next, 'datachannel unavailable', 'rtc_unavailable');
    expect(next.dc).toBe('datachannel unavailable');
    expect(next.ws).toBe('timeout ws://127.0.0.1:2/peer');
    expect(next.endpointsTried).toEqual(['ws://127.0.0.1:2/peer']);
    expect(prev.dc).toBe('direct_capable=false');
    expect(directFailureView(next)).toEqual({
      at: 20,
      ws: 'timeout ws://127.0.0.1:2/peer',
      wsCode: 'timeout',
      wsParams: { url: 'ws://127.0.0.1:2/peer' },
      dc: 'datachannel unavailable',
      dcCode: 'rtc_unavailable',
      dcParams: null,
    });
  });

  test('清空原文时连带清掉码与参数，不留下无主的 code', () => {
    const attempt = emptyDirectAttempt(5);
    noteWsOutcome(attempt, 'refused', [], 'refused', { url: 'ws://127.0.0.1:1/peer' });
    noteDcOutcome(attempt, 'cooling', 'breaker_cooling', { until: 99 });
    noteWsOutcome(attempt, null, []);
    noteDcOutcome(attempt, null);
    expect(attempt.wsCode).toBeNull();
    expect(attempt.wsParams).toBeNull();
    expect(attempt.dcCode).toBeNull();
    expect(attempt.dcParams).toBeNull();
    expect(directFailureView(attempt)).toBeNull();
  });

  test('clearedDirectAttempt drops ws/dc but keeps endpoints', () => {
    const attempt = emptyDirectAttempt(3);
    noteWsOutcome(attempt, 'refused ws://127.0.0.1:1/peer', ['ws://127.0.0.1:1/peer'], 'refused');
    const cleared = clearedDirectAttempt(attempt);
    expect(cleared).toEqual({
      at: 3,
      ws: null,
      wsCode: null,
      wsParams: null,
      dc: null,
      dcCode: null,
      dcParams: null,
      endpointsTried: ['ws://127.0.0.1:1/peer'],
    });
    expect(directFailureView(cleared)).toBeNull();
  });
});
