import { describe, expect, test } from 'bun:test';
import { parseDurationMs } from './duration';

describe('parseDurationMs', () => {
  test('parses ttl units with minutes as default', () => {
    expect(parseDurationMs('10m')).toBe(600_000);
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('1h')).toBe(3_600_000);
    expect(parseDurationMs('10')).toBe(600_000);
  });
});
