import { describe, expect, test } from 'bun:test';
import { isSelectionEventForRuntime } from './use-pane-active-follow';

const SELF = 'self';
const NODE_B = 'bb'.repeat(16);

describe('isSelectionEventForRuntime', () => {
  test('same nodeId is accepted', () => {
    expect(isSelectionEventForRuntime({ nodeId: SELF }, SELF)).toBe(true);
    expect(isSelectionEventForRuntime({ nodeId: NODE_B }, NODE_B)).toBe(true);
  });

  test('events from another runtime are ignored', () => {
    expect(isSelectionEventForRuntime({ nodeId: NODE_B }, SELF)).toBe(false);
    expect(isSelectionEventForRuntime({ nodeId: SELF }, NODE_B)).toBe(false);
  });
});
