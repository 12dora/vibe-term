// 「内存限额」表单的草稿与校验。口径与网关一致（见 packages/shared/src/contracts/window-memory.ts）：
// 三个额度都是 MB 整数，0 表示这一项不限（其余两项照旧）；软限额不得大于硬限额；采样周期 2–60 秒。
// 越界的值网关一律回 400，与其点了才知道，不如在字段上直接说清楚。
//
// 「不限制」与「自定义限额」是两种方式，对应记录里的 `enabled`。选「不限制」时额度输入框收起，
// 里面的数字只是留着给切回「自定义」用：填坏了也不该挡住「不限制」的保存。

import {
  WINDOW_MEMORY_INTERVAL_MAX_SEC,
  WINDOW_MEMORY_INTERVAL_MIN_SEC,
  WINDOW_MEMORY_MB_MAX,
  type WindowMemorySettings,
  errorMessage,
} from '@vibeterm/shared';

export interface MemoryLimitsDraft {
  enabled: boolean;
  memoryHighMb: string;
  memoryMaxMb: string;
  memorySwapMaxMb: string;
  sampleIntervalSec: string;
}

export type MemoryLimitsField = Exclude<keyof MemoryLimitsDraft, 'enabled'>;

export type MemoryLimitsErrors = Partial<Record<MemoryLimitsField, string>>;

export interface MemoryLimitsParseResult {
  settings: WindowMemorySettings | null;
  errors: MemoryLimitsErrors;
}

const MB_FIELDS = ['memoryHighMb', 'memoryMaxMb', 'memorySwapMaxMb'] as const;

export type MemoryLimitsMode = 'unlimited' | 'custom';

export function memoryLimitsMode(draft: Pick<MemoryLimitsDraft, 'enabled'>): MemoryLimitsMode {
  return draft.enabled ? 'custom' : 'unlimited';
}

/** 记录是否等于「不限制」：关掉开关，或三项额度全为 0。 */
export function isUnlimitedSettings(settings: WindowMemorySettings): boolean {
  if (!settings.enabled) return true;
  return settings.memoryHighMb <= 0 && settings.memoryMaxMb <= 0 && settings.memorySwapMaxMb <= 0;
}

export function memoryLimitsDraft(settings: WindowMemorySettings): MemoryLimitsDraft {
  return {
    enabled: settings.enabled,
    memoryHighMb: String(settings.memoryHighMb),
    memoryMaxMb: String(settings.memoryMaxMb),
    memorySwapMaxMb: String(settings.memorySwapMaxMb),
    sampleIntervalSec: String(settings.sampleIntervalSec),
  };
}

function boundedInteger(raw: string, min: number, max: number): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

type MbField = (typeof MB_FIELDS)[number];

/** 三个额度字段一起解析：任一不合法就整组作废，错误逐字段写回。 */
function parseMbFields(
  draft: MemoryLimitsDraft,
  errors: MemoryLimitsErrors
): Record<MbField, number> | null {
  const values = {} as Record<MbField, number>;
  let ok = true;
  for (const field of MB_FIELDS) {
    const value = boundedInteger(draft[field], 0, WINDOW_MEMORY_MB_MAX);
    if (value === null) {
      errors[field] = 'settings.nodes.memory.invalidMb';
      ok = false;
    } else {
      values[field] = value;
    }
  }
  return ok ? values : null;
}

/** 两边都设了限才比得出高低：0 是「不设这一项」，不参与比较。 */
function highAboveMax(mb: Record<MbField, number>): boolean {
  return mb.memoryHighMb > 0 && mb.memoryMaxMb > 0 && mb.memoryHighMb > mb.memoryMaxMb;
}

const ZERO_MB: Record<MbField, number> = { memoryHighMb: 0, memoryMaxMb: 0, memorySwapMaxMb: 0 };

/**
 * 「不限制」下额度字段是收起的：数字合法就原样留着，不合法（或软高于硬，网关会拒）就一并清零，
 * 错误不写回——用户看不到那几个输入框，报在上面只会让保存莫名失败。
 */
function unlimitedMbFields(draft: MemoryLimitsDraft): Record<MbField, number> {
  const mb = parseMbFields(draft, {});
  return mb && !highAboveMax(mb) ? mb : ZERO_MB;
}

export function parseMemoryLimitsDraft(draft: MemoryLimitsDraft): MemoryLimitsParseResult {
  const errors: MemoryLimitsErrors = {};
  const mb = draft.enabled ? parseMbFields(draft, errors) : unlimitedMbFields(draft);
  const sampleIntervalSec = boundedInteger(
    draft.sampleIntervalSec,
    WINDOW_MEMORY_INTERVAL_MIN_SEC,
    WINDOW_MEMORY_INTERVAL_MAX_SEC
  );
  if (sampleIntervalSec === null) {
    errors.sampleIntervalSec = 'settings.nodes.memory.invalidInterval';
  }
  if (mb && highAboveMax(mb)) errors.memoryHighMb = 'settings.nodes.memory.highAboveMax';

  if (!mb || sampleIntervalSec === null || Object.keys(errors).length > 0) {
    return { settings: null, errors };
  }
  return { settings: { enabled: draft.enabled, ...mb, sampleIntervalSec }, errors };
}

/**
 * 批量写入：方式必须显式选过（`null` 即没选，一个请求都不发）。「不限制」连同额度一起清零——
 * 批量本就不读各节点的旧值，没有「留着给切回用」的数字可言。
 */
export function parseBulkMemoryLimits(
  mode: MemoryLimitsMode | null,
  draft: MemoryLimitsDraft
): MemoryLimitsParseResult {
  if (mode === null) return { settings: null, errors: {} };
  if (mode === 'custom') return parseMemoryLimitsDraft({ ...draft, enabled: true });
  return parseMemoryLimitsDraft({
    ...draft,
    enabled: false,
    memoryHighMb: '0',
    memoryMaxMb: '0',
    memorySwapMaxMb: '0',
  });
}

export function memoryLimitsEqual(a: WindowMemorySettings, b: WindowMemorySettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.memoryHighMb === b.memoryHighMb &&
    a.memoryMaxMb === b.memoryMaxMb &&
    a.memorySwapMaxMb === b.memorySwapMaxMb &&
    a.sampleIntervalSec === b.sampleIntervalSec
  );
}

export interface MemoryLimitsSubmitResult {
  errors: MemoryLimitsErrors;
  /** 网关回写后的记录；校验没过或请求失败时为 null。 */
  saved: WindowMemorySettings | null;
  /** 请求失败的原因；校验没过时为 null（错误已在字段上）。 */
  failure: string | null;
}

/** 先本地校验，过了再整条 PUT：校验没过一次请求都不发。 */
export async function submitMemoryLimits(
  draft: MemoryLimitsDraft,
  put: (settings: WindowMemorySettings) => Promise<WindowMemorySettings>
): Promise<MemoryLimitsSubmitResult> {
  const parsed = parseMemoryLimitsDraft(draft);
  if (!parsed.settings) return { errors: parsed.errors, saved: null, failure: null };
  try {
    return { errors: {}, saved: await put(parsed.settings), failure: null };
  } catch (err) {
    return { errors: {}, saved: null, failure: errorMessage(err) };
  }
}
