import { describe, expect, test } from 'bun:test';
import { SITE_SETTING_KEYS } from '@vibeterm/shared';
import { getTableColumns } from 'drizzle-orm';
import { siteSettings } from './settings';

describe('site_settings schema vs SITE_SETTING_FIELDS', () => {
  test('drizzle columns equal registry keys plus singleton id', () => {
    const columns = Object.keys(getTableColumns(siteSettings)).sort();
    const expected = ['id', ...SITE_SETTING_KEYS].sort();
    expect(columns).toEqual(expected);
  });
});
