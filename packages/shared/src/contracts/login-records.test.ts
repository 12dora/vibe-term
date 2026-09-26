import { describe, expect, test } from 'bun:test';
import {
  LOGIN_RECORD_PAGE_DEFAULT_LIMIT,
  LOGIN_RECORD_PAGE_MAX_LIMIT,
  LOGIN_RECORD_RETENTION_CHOICES,
  LOGIN_RECORD_RETENTION_DEFAULT,
  MIN_LOGIN_RECORDS_VERSION,
  isLoginRecordRetentionDays,
} from './login-records';

describe('login record contract', () => {
  test('retention choices include forever and default to 90 days', () => {
    expect(LOGIN_RECORD_RETENTION_CHOICES).toEqual([7, 30, 90, 180, 0]);
    expect(LOGIN_RECORD_RETENTION_DEFAULT).toBe(90);
    expect(MIN_LOGIN_RECORDS_VERSION).toBe('2.10.0');
    expect(LOGIN_RECORD_PAGE_DEFAULT_LIMIT).toBe(200);
    expect(LOGIN_RECORD_PAGE_MAX_LIMIT).toBe(500);
  });

  test('accepts only the documented retention values', () => {
    for (const days of LOGIN_RECORD_RETENTION_CHOICES) {
      expect(isLoginRecordRetentionDays(days)).toBe(true);
    }
    expect(isLoginRecordRetentionDays(14)).toBe(false);
    expect(isLoginRecordRetentionDays(90.5)).toBe(false);
    expect(isLoginRecordRetentionDays('90')).toBe(false);
  });
});
