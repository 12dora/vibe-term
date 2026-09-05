// 分享设置表单的纯逻辑：服务端值 ↔ 草稿、校验、以及「有没有改动」。
// 组件只负责摆控件与把草稿交回来。

import type { ShareSettings } from '@tmex/shared/share';

export const SHARE_RETENTION_DAYS_MAX = 3650;
export const SHARE_LOG_MB_MAX = 1024;
const MB = 1024 * 1024;

/** 默认分享地址的三种取值：自动、候选地址之一、自定义 URL。 */
export const SHARE_ORIGIN_AUTO = 'auto';
export const SHARE_ORIGIN_CUSTOM = 'custom';

export interface ShareSettingsDraft {
  recordLogs: boolean;
  retentionDays: string;
  logMaxMb: string;
  /** `auto` / `custom` / 候选地址原文。 */
  originChoice: string;
  customOrigin: string;
}

export interface ShareSettingsErrors {
  retentionDays?: string;
  logMaxMb?: string;
  customOrigin?: string;
}

export function shareSettingsToDraft(
  settings: ShareSettings,
  candidates: readonly string[]
): ShareSettingsDraft {
  const origin = settings.defaultOrigin;
  const known = origin !== null && candidates.includes(origin);
  return {
    recordLogs: settings.recordLogs,
    retentionDays: String(settings.logRetentionDays),
    logMaxMb: String(Math.max(1, Math.round(settings.logMaxBytes / MB))),
    originChoice: origin === null ? SHARE_ORIGIN_AUTO : known ? origin : SHARE_ORIGIN_CUSTOM,
    customOrigin: known || origin === null ? '' : origin,
  };
}

function parseCount(raw: string, max: number, min: number): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (value < min || value > max) return null;
  return value;
}

/** 自定义地址只取 origin：带路径/查询的输入一律收敛成 `scheme://host[:port]`。 */
export function normalizeShareOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface ShareSettingsParseResult {
  settings: ShareSettings | null;
  errors: ShareSettingsErrors;
}

export function parseShareSettingsDraft(draft: ShareSettingsDraft): ShareSettingsParseResult {
  const errors: ShareSettingsErrors = {};
  const retentionDays = parseCount(draft.retentionDays, SHARE_RETENTION_DAYS_MAX, 0);
  if (retentionDays === null) errors.retentionDays = 'settings.share.form.retentionError';
  const logMaxMb = parseCount(draft.logMaxMb, SHARE_LOG_MB_MAX, 1);
  if (logMaxMb === null) errors.logMaxMb = 'settings.share.form.logMaxError';

  let defaultOrigin: string | null = null;
  if (draft.originChoice === SHARE_ORIGIN_CUSTOM) {
    defaultOrigin = normalizeShareOrigin(draft.customOrigin);
    if (defaultOrigin === null) errors.customOrigin = 'settings.share.form.originError';
  } else if (draft.originChoice !== SHARE_ORIGIN_AUTO) {
    defaultOrigin = draft.originChoice;
  }

  if (retentionDays === null || logMaxMb === null || Object.keys(errors).length > 0) {
    return { settings: null, errors };
  }
  return {
    settings: {
      recordLogs: draft.recordLogs,
      logRetentionDays: retentionDays,
      logMaxBytes: logMaxMb * MB,
      defaultOrigin,
    },
    errors,
  };
}

export function shareSettingsEqual(a: ShareSettings, b: ShareSettings): boolean {
  return (
    a.recordLogs === b.recordLogs &&
    a.logRetentionDays === b.logRetentionDays &&
    a.logMaxBytes === b.logMaxBytes &&
    a.defaultOrigin === b.defaultOrigin
  );
}

/** 草稿相对已保存值有实际改动（草稿非法时按「有改动」处理，让保存按钮可点并报错）。 */
export function shareSettingsChanged(draft: ShareSettingsDraft, saved: ShareSettings): boolean {
  const parsed = parseShareSettingsDraft(draft);
  if (!parsed.settings) return true;
  return !shareSettingsEqual(parsed.settings, saved);
}
