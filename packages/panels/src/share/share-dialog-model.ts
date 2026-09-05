// 分享弹窗的纯逻辑：草稿形态、时长换算与校验、地址缺省选取、剩余期限分档。
// 组件只消费这里的结果，不再自己算时间和拼请求体。

import type { CreateShareInput } from '@tmex/api-client';
import {
  SHARE_DURATION_PRESETS_MS,
  SHARE_PASSWORD_MIN_LENGTH,
  type ShareOriginCandidate,
  type ShareRecord,
} from '@tmex/shared/share';

export type ShareDurationChoice = 'hour' | 'day' | 'week' | 'permanent' | 'custom';
export type ShareDurationUnit = 'hours' | 'days';

export const SHARE_DURATION_CHOICES: readonly ShareDurationChoice[] = [
  'hour',
  'day',
  'week',
  'permanent',
  'custom',
];

export const SHARE_DURATION_UNIT_MS: Record<ShareDurationUnit, number> = {
  hours: 3_600_000,
  days: 86_400_000,
};

/** 自定义时长上限：一年。再长的场景直接选「永久」。 */
export const SHARE_CUSTOM_MAX_MS = 365 * SHARE_DURATION_UNIT_MS.days;

export interface ShareDraft {
  name: string;
  password: string;
  origin: string;
  duration: ShareDurationChoice;
  customValue: string;
  customUnit: ShareDurationUnit;
}

export interface ShareDraftSeed {
  name: string;
  password: string;
  origin?: string;
}

export function createShareDraft({ name, password, origin = '' }: ShareDraftSeed): ShareDraft {
  return {
    name,
    password,
    origin,
    duration: 'day',
    customValue: '12',
    customUnit: 'hours',
  };
}

/** 永久返回 `null`；自定义值非法返回 `undefined`。 */
export function resolveShareExpiresInMs(draft: ShareDraft): number | null | undefined {
  if (draft.duration === 'permanent') return null;
  if (draft.duration !== 'custom') return SHARE_DURATION_PRESETS_MS[draft.duration];
  const value = Number(draft.customValue.trim());
  if (!Number.isInteger(value) || value <= 0) return undefined;
  const ms = value * SHARE_DURATION_UNIT_MS[draft.customUnit];
  return ms > SHARE_CUSTOM_MAX_MS ? undefined : ms;
}

export interface ShareDraftError {
  key: string;
  params?: Record<string, unknown>;
}

export function validateShareDraft(draft: ShareDraft): ShareDraftError | null {
  if (!draft.name.trim()) return { key: 'share.error.nameRequired' };
  if (draft.password.trim().length < SHARE_PASSWORD_MIN_LENGTH) {
    return { key: 'share.error.passwordTooShort', params: { min: SHARE_PASSWORD_MIN_LENGTH } };
  }
  if (!draft.origin) return { key: 'share.error.noOrigin' };
  if (resolveShareExpiresInMs(draft) === undefined) return { key: 'share.error.invalidDuration' };
  return null;
}

export function buildCreateShareInput(
  draft: ShareDraft,
  deviceId: string,
  windowId: string
): CreateShareInput | null {
  const expiresInMs = resolveShareExpiresInMs(draft);
  if (expiresInMs === undefined) return null;
  return {
    deviceId,
    windowId,
    name: draft.name.trim(),
    password: draft.password.trim(),
    expiresInMs,
    origin: draft.origin,
  };
}

/** 推荐地址必须在候选里才采用；否则退到第一个候选，都没有则空串（此时禁止创建）。 */
export function pickDefaultShareOrigin(
  candidates: readonly ShareOriginCandidate[],
  recommended: string | null
): string {
  if (recommended && candidates.some((candidate) => candidate.url === recommended)) {
    return recommended;
  }
  return candidates[0]?.url ?? '';
}

/** 同一 window 理论上只有一条进行中的分享；真出现多条时取最新创建的那条。 */
export function pickActiveShare(
  active: readonly ShareRecord[] | undefined,
  deviceId?: string,
  windowId?: string
): ShareRecord | null {
  if (!active?.length) return null;
  let picked: ShareRecord | null = null;
  for (const record of active) {
    if (deviceId && record.deviceId !== deviceId) continue;
    if (windowId && record.windowId !== windowId) continue;
    if (!picked || record.createdAt > picked.createdAt) picked = record;
  }
  return picked;
}

export interface CreatedShareRef {
  share: ShareRecord;
  /** 创建时刻（epoch 毫秒）。 */
  at: number;
}

export interface ResolveActiveShareInput {
  /** 列表查询挑出来的进行中分享。 */
  fromQuery: ShareRecord | null;
  /** 本次会话刚创建出来的分享；列表还没转过来时先顶上。 */
  created: CreatedShareRef | null;
  /** 列表最近一次成功落地的时刻（epoch 毫秒），从未成功为 0。 */
  dataUpdatedAt: number;
  /** 刚终止的分享 id：列表缓存还没刷新，按 id 挡掉免得闪回「进行中」。 */
  revokedId: string | null;
}

/**
 * 弹窗显示哪条进行中的分享。
 *
 * 创建结果只兜底到列表同步为止：之后一律以服务端为准，否则分享到期或被另一个页面终止时，
 * 弹窗还挂着一条已经失效的链接、在线人数和「终止」按钮，也没法直接新建。
 */
export function resolveActiveShare({
  fromQuery,
  created,
  dataUpdatedAt,
  revokedId,
}: ResolveActiveShareInput): ShareRecord | null {
  const synced = created !== null && dataUpdatedAt > created.at;
  const latest = fromQuery ?? (synced ? null : (created?.share ?? null));
  return latest && latest.id === revokedId ? null : latest;
}

export type ShareRemainingUnit = 'days' | 'hours' | 'minutes' | 'expired';

export interface ShareRemaining {
  unit: ShareRemainingUnit;
  value: number;
}

/** `null` = 永久。 */
export function shareRemaining(expiresAt: number | null, now: number): ShareRemaining | null {
  if (expiresAt === null) return null;
  const left = expiresAt - now;
  if (left <= 0) return { unit: 'expired', value: 0 };
  if (left >= SHARE_DURATION_UNIT_MS.days) {
    return { unit: 'days', value: Math.floor(left / SHARE_DURATION_UNIT_MS.days) };
  }
  if (left >= SHARE_DURATION_UNIT_MS.hours) {
    return { unit: 'hours', value: Math.floor(left / SHARE_DURATION_UNIT_MS.hours) };
  }
  return { unit: 'minutes', value: Math.max(1, Math.floor(left / 60_000)) };
}

export function shareRemainingKey(remaining: ShareRemaining): string {
  return `share.dialog.remaining.${remaining.unit}`;
}

/** 有进行中的分享才需要盯在线人数；否则退到低频轮询。 */
export const SHARE_ACTIVE_POLL_MS = 10_000;
export const SHARE_IDLE_POLL_MS = 60_000;

export function shareRefetchIntervalMs(hasActiveShare: boolean): number {
  return hasActiveShare ? SHARE_ACTIVE_POLL_MS : SHARE_IDLE_POLL_MS;
}
