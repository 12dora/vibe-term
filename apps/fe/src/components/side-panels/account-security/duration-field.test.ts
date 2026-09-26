import { describe, expect, test } from 'bun:test';
import { durationDraft, durationLabel, durationMs, parsePositiveInt } from './duration-field';

describe('duration-field', () => {
  test('picks the largest exact unit', () => {
    expect(durationDraft(5 * 60_000)).toEqual({ value: '5', unit: 'minutes' });
    expect(durationDraft(90 * 60_000)).toEqual({ value: '90', unit: 'minutes' });
    expect(durationDraft(3_600_000)).toEqual({ value: '1', unit: 'hours' });
    expect(durationDraft(86_400_000)).toEqual({ value: '1', unit: 'days' });
    expect(durationDraft(7 * 86_400_000)).toEqual({ value: '7', unit: 'days' });
  });

  test('round-trips and rejects non-positive integers', () => {
    expect(durationMs({ value: '15', unit: 'minutes' })).toBe(900_000);
    expect(durationMs({ value: '2', unit: 'days' })).toBe(172_800_000);
    for (const bad of ['', '0', '-1', '1.5', 'abc', ' ']) {
      expect(durationMs({ value: bad, unit: 'hours' })).toBeNull();
    }
    expect(parsePositiveInt(' 12 ')).toBe(12);
  });

  test('label uses the auth.duration keys', () => {
    const t = (key: string, o?: Record<string, unknown>) => `${key}:${o?.n}`;
    expect(durationLabel(t, 24 * 3_600_000)).toBe('auth.duration.days:1');
    expect(durationLabel(t, 15 * 60_000)).toBe('auth.duration.minutes:15');
  });
});
