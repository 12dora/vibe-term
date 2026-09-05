import { describe, expect, test } from 'bun:test';
import type { ShareOriginCandidate, ShareRecord } from '@tmex/shared/share';
import {
  SHARE_ACTIVE_POLL_MS,
  SHARE_CUSTOM_MAX_MS,
  SHARE_IDLE_POLL_MS,
  type ShareDraft,
  buildCreateShareInput,
  createShareDraft,
  pickActiveShare,
  pickDefaultShareOrigin,
  resolveShareExpiresInMs,
  shareRefetchIntervalMs,
  shareRemaining,
  shareRemainingKey,
  validateShareDraft,
} from './share-dialog-model';

function draft(overrides: Partial<ShareDraft> = {}): ShareDraft {
  return {
    ...createShareDraft({ name: 'build', password: 'abcdef', origin: 'https://a.example' }),
    ...overrides,
  };
}

function candidate(url: string, kind: ShareOriginCandidate['kind'] = 'site'): ShareOriginCandidate {
  return { url, kind, label: url };
}

function record(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return {
    id: 's1',
    name: 'build',
    deviceId: 'd1',
    windowId: '@1',
    windowName: 'build',
    state: 'active',
    endReason: null,
    createdAt: 1000,
    expiresAt: null,
    endedAt: null,
    origin: 'https://a.example',
    url: 'https://a.example/s/s1',
    viewers: 0,
    logBytes: 0,
    logTruncated: false,
    recordLog: true,
    ...overrides,
  };
}

describe('createShareDraft', () => {
  test('缺省 24 小时，地址可留空由候选补', () => {
    const seeded = createShareDraft({ name: 'tab', password: 'pw1234' });
    expect(seeded.duration).toBe('day');
    expect(seeded.name).toBe('tab');
    expect(seeded.origin).toBe('');
  });
});

describe('resolveShareExpiresInMs', () => {
  test('预设按毫秒换算', () => {
    expect(resolveShareExpiresInMs(draft({ duration: 'hour' }))).toBe(3_600_000);
    expect(resolveShareExpiresInMs(draft({ duration: 'day' }))).toBe(86_400_000);
    expect(resolveShareExpiresInMs(draft({ duration: 'week' }))).toBe(604_800_000);
  });

  test('永久是 null', () => {
    expect(resolveShareExpiresInMs(draft({ duration: 'permanent' }))).toBeNull();
  });

  test('自定义按单位换算', () => {
    expect(
      resolveShareExpiresInMs(draft({ duration: 'custom', customValue: '3', customUnit: 'hours' }))
    ).toBe(3 * 3_600_000);
    expect(
      resolveShareExpiresInMs(draft({ duration: 'custom', customValue: '2', customUnit: 'days' }))
    ).toBe(2 * 86_400_000);
  });

  test('自定义非法值返回 undefined', () => {
    for (const customValue of ['', ' ', '0', '-1', '1.5', 'abc', '366']) {
      expect(
        resolveShareExpiresInMs(draft({ duration: 'custom', customValue, customUnit: 'days' }))
      ).toBeUndefined();
    }
  });

  test('自定义上限刚好一年可用', () => {
    expect(
      resolveShareExpiresInMs(draft({ duration: 'custom', customValue: '365', customUnit: 'days' }))
    ).toBe(SHARE_CUSTOM_MAX_MS);
  });
});

describe('validateShareDraft', () => {
  test('合法草稿通过', () => {
    expect(validateShareDraft(draft())).toBeNull();
  });

  test('名称必填', () => {
    expect(validateShareDraft(draft({ name: '  ' }))?.key).toBe('share.error.nameRequired');
  });

  test('密码不足 6 位并带最小长度参数', () => {
    const error = validateShareDraft(draft({ password: 'abc' }));
    expect(error?.key).toBe('share.error.passwordTooShort');
    expect(error?.params).toEqual({ min: 6 });
  });

  test('未选地址', () => {
    expect(validateShareDraft(draft({ origin: '' }))?.key).toBe('share.error.noOrigin');
  });

  test('自定义时长非法', () => {
    expect(validateShareDraft(draft({ duration: 'custom', customValue: 'x' }))?.key).toBe(
      'share.error.invalidDuration'
    );
  });
});

describe('buildCreateShareInput', () => {
  test('裁掉名称与密码两侧空白，带上 scope 与地址', () => {
    const input = buildCreateShareInput(
      draft({ name: '  build  ', password: ' abcdef ' }),
      'd1',
      '@1'
    );
    expect(input).toEqual({
      deviceId: 'd1',
      windowId: '@1',
      name: 'build',
      password: 'abcdef',
      expiresInMs: 86_400_000,
      origin: 'https://a.example',
    });
  });

  test('永久分享 expiresInMs 为 null', () => {
    expect(
      buildCreateShareInput(draft({ duration: 'permanent' }), 'd1', '@1')?.expiresInMs
    ).toBeNull();
  });

  test('自定义时长非法时不出请求体', () => {
    expect(
      buildCreateShareInput(draft({ duration: 'custom', customValue: '0' }), 'd1', '@1')
    ).toBeNull();
  });
});

describe('pickDefaultShareOrigin', () => {
  const candidates = [candidate('https://a.example'), candidate('https://b.example', 'tunnel')];

  test('推荐地址在候选里就用它', () => {
    expect(pickDefaultShareOrigin(candidates, 'https://b.example')).toBe('https://b.example');
  });

  test('推荐地址不在候选里退回第一个候选', () => {
    expect(pickDefaultShareOrigin(candidates, 'https://gone.example')).toBe('https://a.example');
    expect(pickDefaultShareOrigin(candidates, null)).toBe('https://a.example');
  });

  test('没有候选就是空串', () => {
    expect(pickDefaultShareOrigin([], 'https://a.example')).toBe('');
  });
});

describe('pickActiveShare', () => {
  test('按 scope 过滤', () => {
    const list = [record({ id: 's1' }), record({ id: 's2', windowId: '@2' })];
    expect(pickActiveShare(list, 'd1', '@1')?.id).toBe('s1');
    expect(pickActiveShare(list, 'd1', '@2')?.id).toBe('s2');
    expect(pickActiveShare(list, 'd2', '@1')).toBeNull();
  });

  test('多条时取最新创建的', () => {
    const list = [record({ id: 'old', createdAt: 1 }), record({ id: 'new', createdAt: 2 })];
    expect(pickActiveShare(list, 'd1', '@1')?.id).toBe('new');
  });

  test('空列表与 undefined 都是 null', () => {
    expect(pickActiveShare(undefined)).toBeNull();
    expect(pickActiveShare([])).toBeNull();
  });
});

describe('shareRemaining', () => {
  const now = 1_000_000_000;

  test('永久返回 null', () => {
    expect(shareRemaining(null, now)).toBeNull();
  });

  test('按天/小时/分钟分档', () => {
    expect(shareRemaining(now + 3 * 86_400_000, now)).toEqual({ unit: 'days', value: 3 });
    expect(shareRemaining(now + 5 * 3_600_000, now)).toEqual({ unit: 'hours', value: 5 });
    expect(shareRemaining(now + 90_000, now)).toEqual({ unit: 'minutes', value: 1 });
  });

  test('不足一分钟仍显示 1 分钟，到期显示已过期', () => {
    expect(shareRemaining(now + 1_000, now)).toEqual({ unit: 'minutes', value: 1 });
    expect(shareRemaining(now, now)).toEqual({ unit: 'expired', value: 0 });
    expect(shareRemaining(now - 1, now)).toEqual({ unit: 'expired', value: 0 });
  });

  test('分档映射到 i18n key', () => {
    expect(shareRemainingKey({ unit: 'days', value: 3 })).toBe('share.dialog.remaining.days');
    expect(shareRemainingKey({ unit: 'expired', value: 0 })).toBe('share.dialog.remaining.expired');
  });
});

describe('shareRefetchIntervalMs', () => {
  test('有分享才盯紧', () => {
    expect(shareRefetchIntervalMs(true)).toBe(SHARE_ACTIVE_POLL_MS);
    expect(shareRefetchIntervalMs(false)).toBe(SHARE_IDLE_POLL_MS);
    expect(SHARE_ACTIVE_POLL_MS).toBeLessThan(SHARE_IDLE_POLL_MS);
  });
});
