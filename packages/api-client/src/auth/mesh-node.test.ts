import { describe, expect, test } from 'bun:test';
import { DIRECT_FAILURE_CODES as fromShared } from '@vibeterm/shared';
import { DIRECT_FAILURE_CODES } from './types';

describe('api-client MeshNode re-export', () => {
  test('DIRECT_FAILURE_CODES is the shared array', () => {
    expect(DIRECT_FAILURE_CODES).toBe(fromShared);
  });
});
