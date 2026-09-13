import { describe, expect, test } from 'bun:test';
import { ProtocolMismatchError, requireRootEpoch } from './types-mode';

describe('requireRootEpoch', () => {
  test('returns a non-negative integer epoch', () => {
    expect(requireRootEpoch({ rootEpoch: 0 })).toBe(0);
    expect(requireRootEpoch({ rootEpoch: 3 })).toBe(3);
  });

  test('rejects missing or invalid epoch instead of defaulting to 0', () => {
    expect(() => requireRootEpoch({})).toThrow(ProtocolMismatchError);
    expect(() => requireRootEpoch({ rootEpoch: null })).toThrow(ProtocolMismatchError);
    expect(() => requireRootEpoch({ rootEpoch: -1 })).toThrow(ProtocolMismatchError);
    expect(() => requireRootEpoch({ rootEpoch: 1.5 })).toThrow(ProtocolMismatchError);
  });
});
