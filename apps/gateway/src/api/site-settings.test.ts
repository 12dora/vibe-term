import { describe, expect, test } from 'bun:test';
import type { UpdateSiteSettingsRequest } from '@vibeterm/shared';
import { type SiteSettingsUpdates, normalizeSiteSettingsInput } from './site-settings';

function asBody(value: unknown): UpdateSiteSettingsRequest {
  return value as UpdateSiteSettingsRequest;
}

describe('normalizeSiteSettingsInput', () => {
  test('composes registry fields and ignores omitted ones', () => {
    expect(normalizeSiteSettingsInput({ siteName: '  VibeTerm  ', language: 'zh_CN' })).toEqual({
      siteName: 'VibeTerm',
      language: 'zh_CN',
    });

    const result = normalizeSiteSettingsInput({
      siteName: '  VibeTerm  ',
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
      siteName: 'VibeTerm',
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
    expect(() => normalizeSiteSettingsInput(asBody({ siteName: '  ' }))).toThrow();
    expect(() => normalizeSiteSettingsInput(asBody({ siteUrl: 'ftp://x' }))).toThrow();
    const updates: SiteSettingsUpdates = normalizeSiteSettingsInput({
      siteUrl: 'https://example.test',
    });
    expect(updates.siteUrl).toBe('https://example.test');
  });

  test('throttle rejects out-of-range values and floors numbers', () => {
    expect(() => normalizeSiteSettingsInput({ bellThrottleSeconds: -1 })).toThrow();
    expect(() => normalizeSiteSettingsInput({ notificationThrottleSeconds: 301 })).toThrow();
    const updates = normalizeSiteSettingsInput({
      bellThrottleSeconds: 1.9,
      notificationThrottleSeconds: 0,
    });
    expect(updates.bellThrottleSeconds).toBe(1);
    expect(updates.notificationThrottleSeconds).toBe(0);
  });

  test('notification toggles require booleans', () => {
    expect(() => normalizeSiteSettingsInput(asBody({ enableBellPush: 'yes' }))).toThrow();
    const updates = normalizeSiteSettingsInput({ enableBellPush: false, enableBellSound: true });
    expect(updates.enableBellPush).toBe(false);
    expect(updates.enableBellSound).toBe(true);
  });

  test('ssh reconnect validates retries and delay ranges', () => {
    expect(() => normalizeSiteSettingsInput({ sshReconnectMaxRetries: 21 })).toThrow();
    expect(() => normalizeSiteSettingsInput({ sshReconnectDelaySeconds: 0 })).toThrow();
    const updates = normalizeSiteSettingsInput({
      sshReconnectMaxRetries: 2.8,
      sshReconnectDelaySeconds: 3,
    });
    expect(updates.sshReconnectMaxRetries).toBe(2);
    expect(updates.sshReconnectDelaySeconds).toBe(3);
  });

  test('language must be a supported locale', () => {
    expect(() => normalizeSiteSettingsInput(asBody({ language: 'fr_FR' }))).toThrow();
    expect(normalizeSiteSettingsInput({ language: 'en_US' }).language).toBe('en_US');
  });

  test('disabled channels trim, drop empties, and dedupe without binding registered ids', () => {
    expect(() =>
      normalizeSiteSettingsInput(asBody({ disabledNotificationChannels: [1] }))
    ).toThrow();
    expect(
      normalizeSiteSettingsInput({
        disabledNotificationChannels: [' a ', '', 'a', 'b'],
      }).disabledNotificationChannels
    ).toEqual(['a', 'b']);
  });

  test('theme and updatedAt in the body are ignored', () => {
    const updates = normalizeSiteSettingsInput(
      asBody({ theme: 'light', updatedAt: 'nope', enableBellSound: false })
    );
    expect(updates).toEqual({ enableBellSound: false });
  });
});
