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
    noteDcOutcome(prev, 'direct_capable=false');
    noteWsOutcome(prev, 'refused ws://127.0.0.1:1/peer', ['ws://127.0.0.1:1/peer']);
    const next = emptyDirectAttempt(20);
    noteWsOutcome(next, 'timeout ws://127.0.0.1:2/peer', ['ws://127.0.0.1:2/peer']);
    noteDcOutcome(next, 'datachannel unavailable');
    expect(next.dc).toBe('datachannel unavailable');
    expect(next.ws).toBe('timeout ws://127.0.0.1:2/peer');
    expect(next.endpointsTried).toEqual(['ws://127.0.0.1:2/peer']);
    expect(prev.dc).toBe('direct_capable=false');
    expect(directFailureView(next)).toEqual({
      at: 20,
      ws: 'timeout ws://127.0.0.1:2/peer',
      dc: 'datachannel unavailable',
    });
  });

  test('clearedDirectAttempt drops ws/dc but keeps endpoints', () => {
    const attempt = emptyDirectAttempt(3);
    noteWsOutcome(attempt, 'refused ws://127.0.0.1:1/peer', ['ws://127.0.0.1:1/peer']);
    const cleared = clearedDirectAttempt(attempt);
    expect(cleared).toEqual({
      at: 3,
      ws: null,
      dc: null,
      endpointsTried: ['ws://127.0.0.1:1/peer'],
    });
    expect(directFailureView(cleared)).toBeNull();
  });
});
