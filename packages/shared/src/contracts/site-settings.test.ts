import { describe, expect, test } from 'bun:test';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from '../i18n/resources';
import {
  SITE_SETTING_CLI_KEYS,
  SITE_SETTING_CLI_USAGE_LINES,
  SITE_SETTING_FIELDS,
  SITE_SETTING_KEYS,
  SITE_SETTING_SECRET_FLAGS,
  THEME_MODES,
  siteSettingCliFlagSpec,
  siteSettingSecretFlags,
} from './site-settings';

describe('SITE_SETTING_FIELDS', () => {
  test('keys are unique and match SITE_SETTING_KEYS', () => {
    const keys = SITE_SETTING_FIELDS.map((field) => field.key);
    expect(keys).toEqual([...SITE_SETTING_KEYS]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('CLI keys are the patchable fields with cliFlag, in registry order', () => {
    expect(SITE_SETTING_CLI_KEYS).toEqual([
      'siteName',
      'siteUrl',
      'bellThrottleSeconds',
      'notificationThrottleSeconds',
      'enableBrowserNotificationToast',
      'enableNotificationPush',
      'enableBellPush',
      'enableBellSound',
      'sshReconnectMaxRetries',
      'sshReconnectDelaySeconds',
      'language',
      'disabledNotificationChannels',
    ]);
    expect(SITE_SETTING_CLI_KEYS).toEqual(
      SITE_SETTING_FIELDS.flatMap((field) => (field.patch && field.cliFlag ? [field.cliFlag] : []))
    );
  });

  test('theme and updatedAt are stored but not PATCH/CLI', () => {
    const theme = SITE_SETTING_FIELDS.find((field) => field.key === 'theme');
    const updatedAt = SITE_SETTING_FIELDS.find((field) => field.key === 'updatedAt');
    expect(theme).toMatchObject({ kind: 'enum', patch: false, cliFlag: null, default: 'dark' });
    expect(theme && 'values' in theme ? [...theme.values] : []).toEqual([...THEME_MODES]);
    expect(updatedAt).toMatchObject({ kind: 'string', patch: false, cliFlag: null });
  });

  test('language enum tracks available locales', () => {
    const language = SITE_SETTING_FIELDS.find((field) => field.key === 'language');
    expect(language && 'values' in language ? [...language.values] : []).toEqual([
      ...AVAILABLE_LOCALES,
    ]);
    expect(language?.default).toBe(DEFAULT_LOCALE);
  });

  test('secret flag triplets stay empty until a secret field is added', () => {
    expect(siteSettingSecretFlags()).toEqual({});
    expect(SITE_SETTING_SECRET_FLAGS).toEqual({});
  });

  test('CLI flag spec covers every cliFlag', () => {
    const spec = siteSettingCliFlagSpec();
    expect(Object.keys(spec)).toEqual([...SITE_SETTING_CLI_KEYS]);
    expect(spec.siteName).toBe('string');
    expect(spec.enableBellPush).toBe('boolean');
    expect(spec.bellThrottleSeconds).toBe('number');
    expect(spec.disabledNotificationChannels).toBe('strings');
    expect(spec.language).toBe('string');
  });

  test('USAGE line is the historical site help text', () => {
    expect(SITE_SETTING_CLI_USAGE_LINES).toEqual([
      '  site get|set <key> <value>     GET/PATCH /api/settings/site',
    ]);
  });
});
