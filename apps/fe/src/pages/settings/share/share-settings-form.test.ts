// 分享设置表单：服务端值 ↔ 草稿、校验、改动判定。

import { describe, expect, test } from 'bun:test';
import type { ShareSettings } from '@tmex/shared/share';
import {
  SHARE_ORIGIN_AUTO,
  SHARE_ORIGIN_CUSTOM,
  type ShareSettingsDraft,
  normalizeShareOrigin,
  parseShareSettingsDraft,
  shareSettingsChanged,
  shareSettingsToDraft,
} from './share-settings-form';

const MB = 1024 * 1024;

const SAVED: ShareSettings = {
  recordLogs: true,
  logRetentionDays: 30,
  logMaxBytes: 50 * MB,
  defaultOrigin: null,
};

const CANDIDATES = ['https://a.example.com', 'https://b.example.com'];

function draft(patch: Partial<ShareSettingsDraft> = {}): ShareSettingsDraft {
  return { ...shareSettingsToDraft(SAVED, CANDIDATES), ...patch };
}

describe('shareSettingsToDraft', () => {
  test('未固定地址即「自动」', () => {
    expect(shareSettingsToDraft(SAVED, CANDIDATES)).toEqual({
      recordLogs: true,
      retentionDays: '30',
      logMaxMb: '50',
      originChoice: SHARE_ORIGIN_AUTO,
      customOrigin: '',
    });
  });

  test('固定的地址在候选里就选中它', () => {
    const next = shareSettingsToDraft({ ...SAVED, defaultOrigin: CANDIDATES[1] }, CANDIDATES);
    expect(next.originChoice).toBe(CANDIDATES[1]);
    expect(next.customOrigin).toBe('');
  });

  test('候选里没有的地址落到「自定义」并回填输入框', () => {
    const next = shareSettingsToDraft(
      { ...SAVED, defaultOrigin: 'https://own.example' },
      CANDIDATES
    );
    expect(next.originChoice).toBe(SHARE_ORIGIN_CUSTOM);
    expect(next.customOrigin).toBe('https://own.example');
  });

  test('上限换算成 MB，不足 1 MB 也按 1 MB 展示', () => {
    expect(shareSettingsToDraft({ ...SAVED, logMaxBytes: 1024 }, CANDIDATES).logMaxMb).toBe('1');
  });
});

describe('normalizeShareOrigin', () => {
  test('只留 origin，路径与查询丢掉', () => {
    expect(normalizeShareOrigin(' https://x.example/path?q=1 ')).toBe('https://x.example');
    expect(normalizeShareOrigin('http://x.example:8080')).toBe('http://x.example:8080');
  });

  test('空串与非 http(s) 一律不接受', () => {
    expect(normalizeShareOrigin('')).toBeNull();
    expect(normalizeShareOrigin('x.example')).toBeNull();
    expect(normalizeShareOrigin('ftp://x.example')).toBeNull();
  });
});

describe('parseShareSettingsDraft', () => {
  test('合法草稿换算回服务端形状', () => {
    const parsed = parseShareSettingsDraft(draft({ retentionDays: '7', logMaxMb: '20' }));
    expect(parsed.errors).toEqual({});
    expect(parsed.settings).toEqual({
      recordLogs: true,
      logRetentionDays: 7,
      logMaxBytes: 20 * MB,
      defaultOrigin: null,
    });
  });

  test('保留天数 0 合法（不自动清理）', () => {
    expect(parseShareSettingsDraft(draft({ retentionDays: '0' })).settings?.logRetentionDays).toBe(
      0
    );
  });

  test('非整数、负数、越界一律报错且不提交', () => {
    for (const value of ['', ' ', '-1', '1.5', 'abc', '4000']) {
      const parsed = parseShareSettingsDraft(draft({ retentionDays: value }));
      expect(parsed.settings).toBeNull();
      expect(parsed.errors.retentionDays).toBe('settings.share.form.retentionError');
    }
  });

  test('上限至少 1 MB', () => {
    expect(parseShareSettingsDraft(draft({ logMaxMb: '0' })).errors.logMaxMb).toBe(
      'settings.share.form.logMaxError'
    );
    expect(parseShareSettingsDraft(draft({ logMaxMb: '2000' })).errors.logMaxMb).toBe(
      'settings.share.form.logMaxError'
    );
  });

  test('选中候选地址即固定成该地址', () => {
    const parsed = parseShareSettingsDraft(draft({ originChoice: CANDIDATES[0] }));
    expect(parsed.settings?.defaultOrigin).toBe(CANDIDATES[0]);
  });

  test('自定义地址收敛成 origin；填不出合法 URL 就报错', () => {
    const ok = parseShareSettingsDraft(
      draft({ originChoice: SHARE_ORIGIN_CUSTOM, customOrigin: 'https://own.example/x' })
    );
    expect(ok.settings?.defaultOrigin).toBe('https://own.example');

    const bad = parseShareSettingsDraft(
      draft({ originChoice: SHARE_ORIGIN_CUSTOM, customOrigin: 'own.example' })
    );
    expect(bad.settings).toBeNull();
    expect(bad.errors.customOrigin).toBe('settings.share.form.originError');
  });
});

describe('shareSettingsChanged', () => {
  test('原样起草即没有改动', () => {
    expect(shareSettingsChanged(draft(), SAVED)).toBe(false);
  });

  test('任一字段变了就算有改动', () => {
    expect(shareSettingsChanged(draft({ recordLogs: false }), SAVED)).toBe(true);
    expect(shareSettingsChanged(draft({ retentionDays: '7' }), SAVED)).toBe(true);
    expect(shareSettingsChanged(draft({ originChoice: CANDIDATES[0] }), SAVED)).toBe(true);
  });

  test('草稿非法时按「有改动」处理，保存按钮可点并报错', () => {
    expect(shareSettingsChanged(draft({ retentionDays: 'x' }), SAVED)).toBe(true);
  });
});
