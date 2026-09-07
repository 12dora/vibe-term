import { describe, expect, test } from 'bun:test';
import { KEYLOG_RECORD_COMPAT, MIN_ROTATE_ROOT_KEEP_RECORD_VERSION } from './key-log-compat';

describe('key-log compatibility policy', () => {
  test('keep rotation refuses unknown member versions and cannot be forced', () => {
    expect(KEYLOG_RECORD_COMPAT['rotate-root-keep']).toEqual({
      minVersion: MIN_ROTATE_ROOT_KEEP_RECORD_VERSION,
      allowForce: false,
      failClosedUncached: true,
    });
  });
});
