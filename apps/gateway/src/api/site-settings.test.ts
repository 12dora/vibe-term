import { describe, expect, test } from 'bun:test';
import type { UpdateSiteSettingsRequest } from '@tmex/shared';
import {
  type SiteSettingsUpdates,
  normalizeDisabledNotificationChannels,
  normalizeLanguageSetting,
  normalizeNotificationToggles,
  normalizeSiteIdentity,
  normalizeSiteSettingsInput,
  normalizeSshReconnectSettings,
  normalizeThrottleSettings,
} from './site-settings';

function asBody(value: unknown): UpdateSiteSettingsRequest {
  return value as UpdateSiteSettingsRequest;
}

describe('normalizeSiteSettingsInput', () => {
  test('composes per-section normalizers and ignores omitted fields', () => {
    expect(normalizeSiteSettingsInput({ siteName: '  tmex  ', language: 'zh_CN' })).toEqual({
      siteName: 'tmex',
      language: 'zh_CN',
    });

    const result = normalizeSiteSettingsInput({
      siteName: '  tmex  ',
      siteUrl: 'https://example.test',
      language: 'zh_CN',
      bellThrottleSeconds: 1.9,
      notificationThrottleSeconds: 0,
      enableBrowserNotificationToast: true,
      enableNotificationPush: false,
      enableBellPush: false,
      enableBellSound: true,
      sshReconnectMaxRetries: 2.8,
      sshReconnectDelaySeconds: 3,
      disabledNotificationChannels: [' a ', '', 'a', 'b'],
    });
    expect(result).toEqual({
      siteName: 'tmex',
      siteUrl: 'https://example.test',
      language: 'zh_CN',
      bellThrottleSeconds: 1,
      notificationThrottleSeconds: 0,
      enableBrowserNotificationToast: true,
      enableNotificationPush: false,
      enableBellPush: false,
      enableBellSound: true,
      sshReconnectMaxRetries: 2,
      sshReconnectDelaySeconds: 3,
      disabledNotificationChannels: ['a', 'b'],
    });
  });

  test('identity rejects empty siteName and non-http siteUrl', () => {
    const updates: SiteSettingsUpdates = {};
    expect(() => normalizeSiteIdentity(asBody({ siteName: '  ' }), updates)).toThrow();
    expect(() => normalizeSiteIdentity(asBody({ siteUrl: 'ftp://x' }), updates)).toThrow();
    normalizeSiteIdentity({ siteUrl: 'https://example.test' }, updates);
    expect(updates.siteUrl).toBe('https://example.test');
  });

  test('throttle rejects out-of-range values and floors numbers', () => {
    const updates: SiteSettingsUpdates = {};
    expect(() => normalizeThrottleSettings({ bellThrottleSeconds: -1 }, updates)).toThrow();
    expect(() =>
      normalizeThrottleSettings({ notificationThrottleSeconds: 301 }, updates)
    ).toThrow();
    normalizeThrottleSettings(
      { bellThrottleSeconds: 1.9, notificationThrottleSeconds: 0 },
      updates
    );
    expect(updates.bellThrottleSeconds).toBe(1);
    expect(updates.notificationThrottleSeconds).toBe(0);
  });

  test('notification toggles require booleans', () => {
    const updates: SiteSettingsUpdates = {};
    expect(() =>
      normalizeNotificationToggles(asBody({ enableBellPush: 'yes' }), updates)
    ).toThrow();
    normalizeNotificationToggles({ enableBellPush: false, enableBellSound: true }, updates);
    expect(updates.enableBellPush).toBe(false);
    expect(updates.enableBellSound).toBe(true);
  });

  test('ssh reconnect validates retries and delay ranges', () => {
    const updates: SiteSettingsUpdates = {};
    expect(() => normalizeSshReconnectSettings({ sshReconnectMaxRetries: 21 }, updates)).toThrow();
    expect(() => normalizeSshReconnectSettings({ sshReconnectDelaySeconds: 0 }, updates)).toThrow();
    normalizeSshReconnectSettings(
      { sshReconnectMaxRetries: 2.8, sshReconnectDelaySeconds: 3 },
      updates
    );
    expect(updates.sshReconnectMaxRetries).toBe(2);
    expect(updates.sshReconnectDelaySeconds).toBe(3);
  });

  test('language must be a supported locale', () => {
    const updates: SiteSettingsUpdates = {};
    expect(() => normalizeLanguageSetting(asBody({ language: 'fr_FR' }), updates)).toThrow();
    normalizeLanguageSetting({ language: 'en_US' }, updates);
    expect(updates.language).toBe('en_US');
  });

  test('disabled channels trim, drop empties, and dedupe without binding registered ids', () => {
    const updates: SiteSettingsUpdates = {};
    expect(() =>
      normalizeDisabledNotificationChannels(asBody({ disabledNotificationChannels: [1] }), updates)
    ).toThrow();
    normalizeDisabledNotificationChannels(
      { disabledNotificationChannels: [' a ', '', 'a', 'b'] },
      updates
    );
    expect(updates.disabledNotificationChannels).toEqual(['a', 'b']);
  });
});
