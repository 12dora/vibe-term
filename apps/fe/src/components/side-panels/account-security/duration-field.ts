// 时长输入：数值 + 单位（分钟 / 小时 / 天），与毫秒互转。

export type DurationUnit = 'minutes' | 'hours' | 'days';

export const DURATION_UNITS: readonly DurationUnit[] = ['minutes', 'hours', 'days'];

const UNIT_MS: Record<DurationUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

export interface DurationDraft {
  value: string;
  unit: DurationUnit;
}

/** 取能整除的最大单位：24 小时显示成「1 天」，90 分钟仍是「90 分钟」。 */
export function durationDraft(ms: number): DurationDraft {
  for (const unit of ['days', 'hours'] as const) {
    if (ms >= UNIT_MS[unit] && ms % UNIT_MS[unit] === 0) {
      return { value: String(ms / UNIT_MS[unit]), unit };
    }
  }
  return { value: String(Math.round(ms / UNIT_MS.minutes)), unit: 'minutes' };
}

/** 非正整数返回 `null`。 */
export function durationMs(draft: DurationDraft): number | null {
  const value = parsePositiveInt(draft.value);
  return value === null ? null : value * UNIT_MS[draft.unit];
}

export function parsePositiveInt(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 预设卡片与校验提示里的时长：同样取能整除的最大单位。 */
export function durationLabel(t: Translate, ms: number): string {
  const draft = durationDraft(ms);
  return t(`auth.duration.${draft.unit}`, { n: Number(draft.value) });
}
