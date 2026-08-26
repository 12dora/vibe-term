import { describe, expect, test } from 'bun:test';
import type { SiteSettings } from '@tmex/shared';
import {
  buildSiteSettingsPayload,
  createDefaultSiteSettingsDraft,
  siteSettingsToDraft,
} from './site-settings-form';

function makeSettings(overrides: Partial<SiteSettings> = {}): SiteSettings {
  return {
    siteName: 'my-tmex',
    siteUrl: 'https://tmex.example.com',
    bellThrottleSeconds: 12,
    notificationThrottleSeconds: 7,
    enableBrowserNotificationToast: false,
    enableNotificationPush: false,
    enableBellPush: false,
    enableBellSound: false,
    sshReconnectMaxRetries: 8,
    sshReconnectDelaySeconds: 45,
    language: 'zh_CN',
    theme: 'dark',
    disabledNotificationChannels: ['webhook'],
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('createDefaultSiteSettingsDraft', () => {
  test('未加载站点设置前使用与旧实现一致的默认值', () => {
    const draft = createDefaultSiteSettingsDraft('https://local.example');

    expect(draft).toEqual({
      siteName: 'tmex',
      siteUrl: 'https://local.example',
      language: 'en_US',
      bellThrottleSeconds: 6,
      notificationThrottleSeconds: 3,
      enableBrowserNotificationToast: true,
      enableNotificationPush: true,
      enableBellPush: true,
      enableBellSound: true,
      sshReconnectMaxRetries: 2,
      sshReconnectDelaySeconds: 10,
    });
  });
});

describe('siteSettingsToDraft', () => {
  test('加载后的设置全量注水，含 SSH 重连配置', () => {
    const draft = siteSettingsToDraft(makeSettings());

    expect(draft).toEqual({
      siteName: 'my-tmex',
      siteUrl: 'https://tmex.example.com',
      language: 'zh_CN',
      bellThrottleSeconds: 12,
      notificationThrottleSeconds: 7,
      enableBrowserNotificationToast: false,
      enableNotificationPush: false,
      enableBellPush: false,
      enableBellSound: false,
      sshReconnectMaxRetries: 8,
      sshReconnectDelaySeconds: 45,
    });
  });

  test('缺失字段回落到默认值', () => {
    const partial = makeSettings();
    // 老服务端可能不返回这些字段
    (partial as Partial<SiteSettings>).language = undefined;
    (partial as Partial<SiteSettings>).notificationThrottleSeconds = undefined;
    (partial as Partial<SiteSettings>).enableBellSound = undefined;
    (partial as Partial<SiteSettings>).sshReconnectMaxRetries = undefined;
    (partial as Partial<SiteSettings>).sshReconnectDelaySeconds = undefined;

    const draft = siteSettingsToDraft(partial);

    expect(draft.language).toBe('en_US');
    expect(draft.notificationThrottleSeconds).toBe(3);
    expect(draft.enableBellSound).toBe(true);
    expect(draft.sshReconnectMaxRetries).toBe(2);
    expect(draft.sshReconnectDelaySeconds).toBe(10);
  });
});

describe('buildSiteSettingsPayload', () => {
  test('注水后直接保存不会把 SSH 重连配置重置为默认值', () => {
    const draft = siteSettingsToDraft(makeSettings());
    const payload = buildSiteSettingsPayload(draft);

    expect(payload.sshReconnectMaxRetries).toBe(8);
    expect(payload.sshReconnectDelaySeconds).toBe(45);
  });

  test('仅修改其他字段时 SSH 重连配置保持原值', () => {
    const draft = { ...siteSettingsToDraft(makeSettings()), siteName: 'renamed' };
    const payload = buildSiteSettingsPayload(draft);

    expect(payload).toEqual({
      siteName: 'renamed',
      siteUrl: 'https://tmex.example.com',
      language: 'zh_CN',
      bellThrottleSeconds: 12,
      notificationThrottleSeconds: 7,
      enableBrowserNotificationToast: false,
      enableNotificationPush: false,
      enableBellPush: false,
      enableBellSound: false,
      sshReconnectMaxRetries: 8,
      sshReconnectDelaySeconds: 45,
    });
  });
});
