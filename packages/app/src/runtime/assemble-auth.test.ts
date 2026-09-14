import { describe, expect, test } from 'bun:test';
import { isRelayOnly } from './assemble-auth';

describe('isRelayOnly', () => {
  test('true only when relay is set without node', () => {
    expect(isRelayOnly({ relay: true, node: false })).toBe(true);
    expect(isRelayOnly({ relay: true, node: true })).toBe(false);
    expect(isRelayOnly({ relay: false, node: false })).toBe(false);
  });
});
