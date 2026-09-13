import { describe, expect, test } from 'bun:test';
import { isRelayOnly } from './assemble-auth';

describe('isRelayOnly', () => {
  test('true only when relay is set without node or hub', () => {
    expect(isRelayOnly({ relay: true, node: false, hub: false })).toBe(true);
    expect(isRelayOnly({ relay: true, node: true, hub: false })).toBe(false);
    expect(isRelayOnly({ relay: true, node: false, hub: true })).toBe(false);
    expect(isRelayOnly({ relay: false, node: false, hub: false })).toBe(false);
  });
});
