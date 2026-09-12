import { describe, expect, test } from 'bun:test';
import { DEFAULT_TURN_RELAY_PORT_RANGE } from '@vibeterm/shared/net';
import {
  DEFAULT_MAX_ALLOCATIONS,
  DEFAULT_MAX_ALLOCATIONS_PER_USER,
  clampTurnAllocations,
  turnRelayRangeSize,
} from './turn-limits';

describe('clampTurnAllocations', () => {
  test('default range size is 49 and clamps the 64 default', () => {
    expect(turnRelayRangeSize(DEFAULT_TURN_RELAY_PORT_RANGE)).toBe(49);
    expect(clampTurnAllocations(DEFAULT_TURN_RELAY_PORT_RANGE)).toEqual({
      maxAllocations: 49,
      maxAllocationsPerUser: DEFAULT_MAX_ALLOCATIONS_PER_USER,
    });
    expect(DEFAULT_MAX_ALLOCATIONS).toBe(64);
  });

  test('a larger range keeps the default caps', () => {
    expect(clampTurnAllocations({ begin: 40001, end: 40100 })).toEqual({
      maxAllocations: DEFAULT_MAX_ALLOCATIONS,
      maxAllocationsPerUser: DEFAULT_MAX_ALLOCATIONS_PER_USER,
    });
  });

  test('a tiny range clamps both default caps', () => {
    expect(clampTurnAllocations({ begin: 40001, end: 40010 })).toEqual({
      maxAllocations: 10,
      maxAllocationsPerUser: 10,
    });
  });

  test('explicit caps are not raised or reduced to the range size', () => {
    expect(
      clampTurnAllocations(
        { begin: 50000, end: 50000 },
        { maxAllocations: 8, maxAllocationsPerUser: 8 }
      )
    ).toEqual({ maxAllocations: 8, maxAllocationsPerUser: 8 });
  });
});
