import { describe, expect, test } from 'bun:test';
import type { RelayQuota } from '@tmex/api-client/relay/admin-api';
import { RELAY_QUOTA_LIMITS } from '@tmex/api-client/relay/admin-api';
import {
  BANDWIDTH_KB_LIMIT,
  PASSWORD_MIN_LENGTH,
  emptyPasswordDraft,
  parsePasswordDraft,
  parseQuotaDraft,
  parseTenantDraft,
  quotaEquals,
  quotaToDraft,
  tenantToDraft,
} from './relay-forms';

const DEFAULT_QUOTA: RelayQuota = {
  maxNodes: 8,
  maxStreams: 16,
  bandwidthBytesPerSec: 524_288,
};

describe('quotaToDraft / parseQuotaDraft', () => {
  test('往返：限速配额', () => {
    const parsed = parseQuotaDraft(quotaToDraft(DEFAULT_QUOTA));
    expect(parsed.quota).toEqual(DEFAULT_QUOTA);
    expect(parsed.errors).toBeNull();
  });

  test('往返：不限速时带宽字段留空并勾上开关', () => {
    const draft = quotaToDraft({ ...DEFAULT_QUOTA, bandwidthBytesPerSec: null });
    expect(draft.unlimited).toBe(true);
    expect(draft.bandwidthKb).toBe('');
    expect(parseQuotaDraft(draft).quota).toEqual({ ...DEFAULT_QUOTA, bandwidthBytesPerSec: null });
  });

  test('勾上不限速时忽略带宽输入框里的残值', () => {
    const parsed = parseQuotaDraft({
      maxNodes: '1',
      maxStreams: '1',
      bandwidthKb: 'xx',
      unlimited: true,
    });
    expect(parsed.quota).toEqual({ maxNodes: 1, maxStreams: 1, bandwidthBytesPerSec: null });
  });

  test('三个字段各自报错，错误里存的是 i18n key', () => {
    const parsed = parseQuotaDraft({
      maxNodes: '0',
      maxStreams: '-2',
      bandwidthKb: '1.5',
      unlimited: false,
    });
    expect(parsed.quota).toBeNull();
    expect(parsed.errors).toEqual({
      maxNodes: 'relay.admin.quota.invalidNodes',
      maxStreams: 'relay.admin.quota.invalidStreams',
      bandwidthKb: 'relay.admin.quota.invalidBandwidth',
    });
  });

  test('空串与纯空白都不合法，前后空白可容忍', () => {
    expect(
      parseQuotaDraft({ maxNodes: '', maxStreams: '1', bandwidthKb: '1', unlimited: false }).errors
        ?.maxNodes
    ).toBe('relay.admin.quota.invalidNodes');
    expect(
      parseQuotaDraft({ maxNodes: ' 4 ', maxStreams: '1', bandwidthKb: '1', unlimited: false })
        .quota
    ).toEqual({ maxNodes: 4, maxStreams: 1, bandwidthBytesPerSec: 1024 });
  });

  test('quotaEquals 逐字段比较', () => {
    expect(quotaEquals(DEFAULT_QUOTA, { ...DEFAULT_QUOTA })).toBe(true);
    expect(quotaEquals(DEFAULT_QUOTA, { ...DEFAULT_QUOTA, maxNodes: 9 })).toBe(false);
    expect(quotaEquals(DEFAULT_QUOTA, { ...DEFAULT_QUOTA, bandwidthBytesPerSec: null })).toBe(
      false
    );
  });
});

describe('tenantToDraft / parseTenantDraft', () => {
  test('没有自己的配额时勾上「跟随默认」，字段用默认值预填', () => {
    const draft = tenantToDraft({ label: null, quota: null }, DEFAULT_QUOTA);
    expect(draft.inherit).toBe(true);
    expect(draft.label).toBe('');
    expect(draft.quota.maxNodes).toBe('8');
  });

  test('跟随默认时提交 quota: null，备注空串归 null', () => {
    const parsed = parseTenantDraft(tenantToDraft({ label: '  ', quota: null }, DEFAULT_QUOTA));
    expect(parsed.patch).toEqual({ quota: null, label: null });
  });

  test('取消跟随后提交具体配额与备注', () => {
    const draft = tenantToDraft(
      { label: ' 上海 ', quota: { maxNodes: 2, maxStreams: 3, bandwidthBytesPerSec: null } },
      DEFAULT_QUOTA
    );
    expect(draft.inherit).toBe(false);
    expect(parseTenantDraft(draft).patch).toEqual({
      quota: { maxNodes: 2, maxStreams: 3, bandwidthBytesPerSec: null },
      label: '上海',
    });
  });

  test('配额非法时整条不提交', () => {
    const parsed = parseTenantDraft({
      inherit: false,
      label: 'x',
      quota: { maxNodes: 'a', maxStreams: '1', bandwidthKb: '1', unlimited: false },
    });
    expect(parsed.patch).toBeNull();
    expect(parsed.errors?.maxNodes).toBe('relay.admin.quota.invalidNodes');
  });

  test('跟随默认时不校验配额字段（残值不该拦下提交）', () => {
    const parsed = parseTenantDraft({
      inherit: true,
      label: 'x',
      quota: { maxNodes: 'a', maxStreams: '', bandwidthKb: '', unlimited: false },
    });
    expect(parsed.patch).toEqual({ quota: null, label: 'x' });
  });
});

describe('parsePasswordDraft', () => {
  test('默认草稿是「保留现有租户」且不清除', () => {
    expect(emptyPasswordDraft()).toEqual({ clear: false, password: '', mode: 'keep' });
  });

  test('口令太短时报错，不发请求', () => {
    const parsed = parsePasswordDraft({ clear: false, password: 'short', mode: 'keep' });
    expect(parsed.body).toBeNull();
    expect(parsed.error).toBe('relay.admin.password.tooShort');
  });

  test('刚好到长度下限即通过', () => {
    const password = 'a'.repeat(PASSWORD_MIN_LENGTH);
    expect(parsePasswordDraft({ clear: false, password, mode: 'kick' }).body).toEqual({
      password,
      mode: 'kick',
    });
  });

  test('清除口令：password 为 null，mode 照发，且不再校验长度', () => {
    expect(parsePasswordDraft({ clear: true, password: '', mode: 'kick' }).body).toEqual({
      password: null,
      mode: 'kick',
    });
  });
});

describe('配额上限（与服务端 relay-quota.ts 对齐）', () => {
  const draft = (
    patch: Partial<{ maxNodes: string; maxStreams: string; bandwidthKb: string }>
  ) => ({
    maxNodes: '8',
    maxStreams: '16',
    bandwidthKb: '512',
    unlimited: false,
    ...patch,
  });

  test('刚好到上限通过，超一格报字段错误', () => {
    expect(
      parseQuotaDraft(draft({ maxNodes: String(RELAY_QUOTA_LIMITS.maxNodes) })).errors
    ).toBeNull();
    expect(
      parseQuotaDraft(draft({ maxNodes: String(RELAY_QUOTA_LIMITS.maxNodes + 1) })).errors
    ).toEqual({ maxNodes: 'relay.admin.quota.invalidNodes' });
    expect(
      parseQuotaDraft(draft({ maxStreams: String(RELAY_QUOTA_LIMITS.maxStreams + 1) })).errors
    ).toEqual({ maxStreams: 'relay.admin.quota.invalidStreams' });
    expect(parseQuotaDraft(draft({ bandwidthKb: String(BANDWIDTH_KB_LIMIT + 1) })).errors).toEqual({
      bandwidthKb: 'relay.admin.quota.invalidBandwidth',
    });
  });

  test('带宽上限按服务端的字节上限折算成 KB/s', () => {
    expect(BANDWIDTH_KB_LIMIT * 1024).toBe(RELAY_QUOTA_LIMITS.bandwidthBytesPerSec);
  });
});
