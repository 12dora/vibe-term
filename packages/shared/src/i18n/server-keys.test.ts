import { describe, expect, test } from 'bun:test';
import { matchesI18nPrefix, partitionTranslation } from './core-keys';
import { isServerI18nKey, pickServerTranslation } from './server-keys';

describe('server i18n keys', () => {
  test('前缀匹配覆盖子 key 与复数后缀，不误伤同名前缀', () => {
    expect(matchesI18nPrefix(['a.b'], 'a.b')).toBe(true);
    expect(matchesI18nPrefix(['a.b'], 'a.b.c')).toBe(true);
    expect(matchesI18nPrefix(['a.b'], 'a.b_other')).toBe(true);
    expect(matchesI18nPrefix(['a.b'], 'a.bc')).toBe(false);
    expect(matchesI18nPrefix(['a.b'], 'a')).toBe(false);
  });

  test('服务端前缀表包含通知与 API 错误，不含前端设置文案', () => {
    expect(isServerI18nKey('apiError.notFound')).toBe(true);
    expect(isServerI18nKey('notification.time')).toBe(true);
    expect(isServerI18nKey('telegram.gatewayOnline')).toBe(true);
    expect(isServerI18nKey('settings.theme')).toBe(false);
    expect(isServerI18nKey('telegram.title')).toBe(false);
  });

  test('拆分叶子守恒，pickServerTranslation 只保留服务端子树', () => {
    const tree = {
      apiError: { notFound: 'Not found' },
      settings: { theme: 'Theme', restartScheduled: 'Restarting' },
      telegram: { gatewayOnline: 'Online', title: 'Telegram' },
    };
    const { matched, rest } = partitionTranslation(tree, isServerI18nKey);
    expect(matched).toEqual(pickServerTranslation(tree));
    expect(matched).toEqual({
      apiError: { notFound: 'Not found' },
      settings: { restartScheduled: 'Restarting' },
      telegram: { gatewayOnline: 'Online' },
    });
    expect(rest).toEqual({ settings: { theme: 'Theme' }, telegram: { title: 'Telegram' } });
  });
});
