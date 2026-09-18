// 对话框里的内存限额表单字段。校验与草稿一律取 `memory-limits-form.ts`（与本机卡同一份），
// 这里只管排版。
//
// 不直接复用本机卡那个段落：本机卡与节点表在同一页上同时渲染，两处共用一套写死的
// `id` / `data-testid` 会在 DOM 里撞车（label htmlFor 只认得第一个）。因此字段 id 带前缀。

import {
  WINDOW_MEMORY_INTERVAL_MAX_SEC,
  WINDOW_MEMORY_INTERVAL_MIN_SEC,
  WINDOW_MEMORY_MB_MAX,
} from '@vibeterm/shared';
import { Input } from '@vibeterm/ui/input';
import { Switch } from '@vibeterm/ui/switch';
import { useTranslation } from 'react-i18next';
import { FormField } from '../../components/form-primitives';
import type {
  MemoryLimitsDraft,
  MemoryLimitsErrors,
  MemoryLimitsField,
} from '../memory-limits-form';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const FIELDS: readonly { field: MemoryLimitsField; labelKey: string; hintKey?: string }[] = [
  {
    field: 'memoryHighMb',
    labelKey: 'settings.nodes.memory.high',
    hintKey: 'settings.nodes.memory.highHint',
  },
  {
    field: 'memoryMaxMb',
    labelKey: 'settings.nodes.memory.max',
    hintKey: 'settings.nodes.memory.maxHint',
  },
  { field: 'memorySwapMaxMb', labelKey: 'settings.nodes.memory.swapMax' },
  { field: 'sampleIntervalSec', labelKey: 'settings.nodes.memory.interval' },
];

function fieldHint(t: Translate, field: MemoryLimitsField, hintKey?: string): string {
  if (field === 'sampleIntervalSec') {
    return t('settings.nodes.memory.intervalHint', {
      min: WINDOW_MEMORY_INTERVAL_MIN_SEC,
      max: WINDOW_MEMORY_INTERVAL_MAX_SEC,
    });
  }
  const unlimited = t('settings.nodes.memory.unlimitedHint');
  return hintKey ? `${t(hintKey)} ${unlimited}` : unlimited;
}

function fieldError(
  t: Translate,
  errors: MemoryLimitsErrors,
  field: MemoryLimitsField
): string | undefined {
  const key = errors[field];
  if (!key) return undefined;
  return t(key, {
    max: field === 'sampleIntervalSec' ? WINDOW_MEMORY_INTERVAL_MAX_SEC : WINDOW_MEMORY_MB_MAX,
    min: WINDOW_MEMORY_INTERVAL_MIN_SEC,
  });
}

export interface MemoryLimitsFieldsProps {
  draft: MemoryLimitsDraft;
  errors: MemoryLimitsErrors;
  /** 字段 id / testid 前缀：同一页上可能开着多份这张表单。 */
  idPrefix: string;
  disabled?: boolean;
  onChange: (patch: Partial<MemoryLimitsDraft>) => void;
}

/** 表单本体。单独导出且不带请求：对话框走 portal，静态渲染只看得到这一块。 */
export function MemoryLimitsFields({
  draft,
  errors,
  idPrefix,
  disabled,
  onChange,
}: MemoryLimitsFieldsProps) {
  const { t } = useTranslation();
  const enabledId = `${idPrefix}-enabled`;
  return (
    <div className="flex flex-col gap-3" data-testid={`${idPrefix}-form`}>
      <label
        className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5"
        htmlFor={enabledId}
      >
        <span className="min-w-0 text-sm font-medium" id={`${enabledId}-label`}>
          {t('settings.nodes.memory.enabled')}
        </span>
        <Switch
          id={enabledId}
          aria-labelledby={`${enabledId}-label`}
          checked={draft.enabled}
          disabled={disabled}
          onCheckedChange={(next) => onChange({ enabled: next === true })}
          data-testid={enabledId}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((item) => (
          <FormField
            key={item.field}
            id={`${idPrefix}-${item.field}`}
            label={t(item.labelKey)}
            hint={fieldHint(t, item.field, item.hintKey)}
            error={fieldError(t, errors, item.field)}
            spacing="tight"
          >
            <Input
              id={`${idPrefix}-${item.field}`}
              inputMode="numeric"
              value={draft[item.field]}
              disabled={disabled}
              onChange={(event) => onChange({ [item.field]: event.target.value })}
              data-testid={`${idPrefix}-${item.field}`}
            />
          </FormField>
        ))}
      </div>
    </div>
  );
}
