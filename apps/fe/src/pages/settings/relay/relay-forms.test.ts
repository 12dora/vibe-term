import { describe, expect, test } from 'bun:test';
import type { RelayQuota } from '@vibeterm/api-client/relay/admin-api';
import { RELAY_QUOTA_LIMITS } from '@vibeterm/api-client/relay/admin-api';
import {
  BANDWIDTH_KB_LIMIT,
  MAX_FILE_MB_LIMIT,
  MAX_TENANTS_LIMIT,
  PASSWORD_MIN_LENGTH,
  emptyPasswordDraft,
  limitsToDraft,
  parseLimitsDraft,
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
  maxFileBytes: null,
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
      maxFileMb: '',
    });
    expect(parsed.quota).toEqual({
      maxNodes: 1,
      maxStreams: 1,
      bandwidthBytesPerSec: null,
      maxFileBytes: null,
    });
  });

  test('四个字段各自报错，错误里存的是 i18n key', () => {
    const parsed = parseQuotaDraft({
      maxNodes: '0',
      maxStreams: '-2',
      bandwidthKb: '1.5',
      unlimited: false,
      maxFileMb: 'x',
    });
    expect(parsed.quota).toBeNull();
    expect(parsed.errors).toEqual({
      maxNodes: 'relay.admin.quota.invalidNodes',
      maxStreams: 'relay.admin.quota.invalidStreams',
      bandwidthKb: 'relay.admin.quota.invalidBandwidth',
      maxFileMb: 'relay.admin.quota.invalidMaxFile',
    });
  });

  test('单文件上限：留空即不限，填了按 MB 折算', () => {
    const draft = quotaToDraft({ ...DEFAULT_QUOTA, maxFileBytes: 100 * 1024 * 1024 });
    expect(draft.maxFileMb).toBe('100');
    expect(parseQuotaDraft(draft).quota?.maxFileBytes).toBe(100 * 1024 * 1024);
    expect(parseQuotaDraft({ ...draft, maxFileMb: '  ' }).quota?.maxFileBytes).toBeNull();
    expect(
      parseQuotaDraft({ ...draft, maxFileMb: String(MAX_FILE_MB_LIMIT + 1) }).errors?.maxFileMb
    ).toBe('relay.admin.quota.invalidMaxFile');
  });

  test('空串与纯空白都不合法，前后空白可容忍', () => {
    expect(
      parseQuotaDraft({
        maxNodes: '',
        maxStreams: '1',
        bandwidthKb: '1',
        unlimited: false,
        maxFileMb: '',
      }).errors?.maxNodes
    ).toBe('relay.admin.quota.invalidNodes');
    expect(
      parseQuotaDraft({
        maxNodes: ' 4 ',
        maxStreams: '1',
        bandwidthKb: '1',
        unlimited: false,
        maxFileMb: '',
      }).quota
    ).toEqual({ maxNodes: 4, maxStreams: 1, bandwidthBytesPerSec: 1024, maxFileBytes: null });
  });

  test('quotaEquals 逐字段比较', () => {
    expect(quotaEquals(DEFAULT_QUOTA, { ...DEFAULT_QUOTA })).toBe(true);
    expect(quotaEquals(DEFAULT_QUOTA, { ...DEFAULT_QUOTA, maxNodes: 9 })).toBe(false);
    expect(quotaEquals(DEFAULT_QUOTA, { ...DEFAULT_QUOTA, bandwidthBytesPerSec: null })).toBe(
      false
    );
    expect(quotaEquals(DEFAULT_QUOTA, { ...DEFAULT_QUOTA, maxFileBytes: 1024 })).toBe(false);
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
      {
        label: ' 上海 ',
        quota: { maxNodes: 2, maxStreams: 3, bandwidthBytesPerSec: null, maxFileBytes: null },
      },
      DEFAULT_QUOTA
    );
    expect(draft.inherit).toBe(false);
    expect(parseTenantDraft(draft).patch).toEqual({
      quota: { maxNodes: 2, maxStreams: 3, bandwidthBytesPerSec: null, maxFileBytes: null },
      label: '上海',
    });
  });

  test('配额非法时整条不提交', () => {
    const parsed = parseTenantDraft({
      inherit: false,
      label: 'x',
      quota: {
        maxNodes: 'a',
        maxStreams: '1',
        bandwidthKb: '1',
        unlimited: false,
        maxFileMb: '',
      },
    });
    expect(parsed.patch).toBeNull();
    expect(parsed.errors?.maxNodes).toBe('relay.admin.quota.invalidNodes');
  });

  test('跟随默认时不校验配额字段（残值不该拦下提交）', () => {
    const parsed = parseTenantDraft({
      inherit: true,
      label: 'x',
      quota: { maxNodes: 'a', maxStreams: '', bandwidthKb: '', unlimited: false, maxFileMb: '' },
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
    maxFileMb: '',
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

  test('节点数上限与服务端 RELAY_CTL_MAX_NODES 一致', () => {
    expect(RELAY_QUOTA_LIMITS.maxNodes).toBe(256);
  });
});

describe('往返保真：没改过的字段不被取整改写', () => {
  test('512 B/s 的带宽在改了别的字段之后仍是 512', () => {
    const draft = quotaToDraft({ ...DEFAULT_QUOTA, bandwidthBytesPerSec: 512 });
    expect(draft.bandwidthKb).toBe('1');
    const parsed = parseQuotaDraft({ ...draft, maxNodes: '9' });
    expect(parsed.quota).toEqual({ ...DEFAULT_QUOTA, maxNodes: 9, bandwidthBytesPerSec: 512 });
  });

  test('1024 字节的单文件上限在改了别的字段之后仍是 1024', () => {
    const draft = quotaToDraft({ ...DEFAULT_QUOTA, maxFileBytes: 1024 });
    expect(draft.maxFileMb).toBe('1');
    const parsed = parseQuotaDraft({ ...draft, maxStreams: '32' });
    expect(parsed.quota).toEqual({ ...DEFAULT_QUOTA, maxStreams: 32, maxFileBytes: 1024 });
  });

  test('改过的字段照常按单位换算', () => {
    const draft = quotaToDraft({ ...DEFAULT_QUOTA, bandwidthBytesPerSec: 512, maxFileBytes: 1024 });
    const parsed = parseQuotaDraft({ ...draft, bandwidthKb: '2', maxFileMb: '3' });
    expect(parsed.quota?.bandwidthBytesPerSec).toBe(2048);
    expect(parsed.quota?.maxFileBytes).toBe(3 * 1024 * 1024);
  });

  test('中继限额的总带宽同样保真', () => {
    const draft = limitsToDraft({
      maxTenants: null,
      totalBandwidthBytesPerSec: 512,
      fairShare: true,
    });
    expect(draft.totalBandwidthKb).toBe('1');
    expect(parseLimitsDraft({ ...draft, maxTenants: '3' }).limits).toEqual({
      maxTenants: 3,
      totalBandwidthBytesPerSec: 512,
      fairShare: true,
    });
    expect(
      parseLimitsDraft({ ...draft, totalBandwidthKb: '2' }).limits?.totalBandwidthBytesPerSec
    ).toBe(2048);
  });

  test('租户草稿从默认配额起草时也保住精确值', () => {
    const exact: RelayQuota = { ...DEFAULT_QUOTA, bandwidthBytesPerSec: 512, maxFileBytes: 1024 };
    const draft = tenantToDraft({ label: 'x', quota: exact }, DEFAULT_QUOTA);
    const parsed = parseTenantDraft({ ...draft, label: 'y' });
    expect(parsed.patch?.quota).toEqual(exact);
  });
});

describe('limitsToDraft / parseLimitsDraft', () => {
  test('未配置限额时三项都是「不限 + 公平分配开」', () => {
    const draft = limitsToDraft(undefined);
    expect(draft).toEqual({
      maxTenants: '',
      totalBandwidthKb: '',
      fairShare: true,
      origin: { totalBandwidthKb: '', totalBandwidthBytes: null },
    });
    expect(parseLimitsDraft(draft).limits).toEqual({
      maxTenants: null,
      totalBandwidthBytesPerSec: null,
      fairShare: true,
    });
  });

  test('往返：填了值按 KB/s 折算', () => {
    const draft = limitsToDraft({
      maxTenants: 4,
      totalBandwidthBytesPerSec: 524_288,
      fairShare: false,
    });
    expect(draft).toEqual({
      maxTenants: '4',
      totalBandwidthKb: '512',
      fairShare: false,
      origin: { totalBandwidthKb: '512', totalBandwidthBytes: 524_288 },
    });
    expect(parseLimitsDraft(draft).limits).toEqual({
      maxTenants: 4,
      totalBandwidthBytesPerSec: 524_288,
      fairShare: false,
    });
  });

  test('越界字段各自报错，错误里存的是 i18n key', () => {
    const parsed = parseLimitsDraft({
      maxTenants: String(MAX_TENANTS_LIMIT + 1),
      totalBandwidthKb: '0',
      fairShare: true,
    });
    expect(parsed.limits).toBeNull();
    expect(parsed.errors).toEqual({
      maxTenants: 'relay.admin.limits.invalidMaxTenants',
      totalBandwidthKb: 'relay.admin.limits.invalidBandwidth',
    });
  });
});
