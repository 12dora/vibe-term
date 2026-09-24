// 内存限额表单字段：本机卡、单台节点对话框、批量对话框三处共用。校验与草稿一律取
// `memory-limits-form.ts`，这里只管排版。
//
// 本机卡与节点表在同一页上同时渲染，写死的 `id` / `data-testid` 会在 DOM 里撞车
// （label htmlFor 只认得第一个），因此字段 id 与单选组名都带前缀。
//
// 最上面是「不限制 / 自定义限额」二选一：「不限制」是一个动作，而不是把三个数字挨个改成 0。
// 选「不限制」时额度输入框收起，只留采样周期。

import {
  WINDOW_MEMORY_INTERVAL_MAX_SEC,
  WINDOW_MEMORY_INTERVAL_MIN_SEC,
  WINDOW_MEMORY_MB_MAX,
} from '@vibeterm/shared';
import { Input } from '@vibeterm/ui/input';
import { InfinityIcon, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '../../components/form-primitives';
import { ChoiceCard } from '../../remote-access/choice-card';
import {
  type MemoryLimitsDraft,
  type MemoryLimitsErrors,
  type MemoryLimitsField,
  type MemoryLimitsMode,
  memoryLimitsMode,
} from '../memory-limits-form';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const MODES: readonly { mode: MemoryLimitsMode; icon: ReactNode }[] = [
  { mode: 'unlimited', icon: <InfinityIcon className="size-4" /> },
  { mode: 'custom', icon: <SlidersHorizontal className="size-4" /> },
];

const INTERVAL_FIELD = {
  field: 'sampleIntervalSec',
  labelKey: 'settings.nodes.memory.interval',
} as const satisfies FieldItem;

type FieldItem = { field: MemoryLimitsField; labelKey: string; hintKey?: string };

const LIMIT_FIELDS: readonly FieldItem[] = [
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

export function MemoryLimitsModeChooser({
  mode,
  idPrefix,
  disabled,
  onSelect,
}: {
  /** `null` = 还没选（批量框的初始状态）。 */
  mode: MemoryLimitsMode | null;
  idPrefix: string;
  disabled?: boolean;
  onSelect: (mode: MemoryLimitsMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="grid gap-3 sm:grid-cols-2"
      role="radiogroup"
      aria-label={t('settings.nodes.memory.modeLabel')}
      data-testid={`${idPrefix}-mode`}
    >
      {MODES.map((item) => (
        <ChoiceCard
          key={item.mode}
          group={`${idPrefix}-mode`}
          value={item.mode}
          icon={item.icon}
          selected={mode === item.mode}
          disabled={disabled === true}
          onSelect={onSelect}
          testidPrefix={`${idPrefix}-mode`}
          i18nPrefix="settings.nodes.memory.mode"
        />
      ))}
    </div>
  );
}

export interface MemoryLimitsFieldsProps {
  draft: MemoryLimitsDraft;
  errors: MemoryLimitsErrors;
  /** 字段 id / testid 前缀：同一页上可能开着多份这张表单。 */
  idPrefix: string;
  disabled?: boolean;
  onChange: (patch: Partial<MemoryLimitsDraft>) => void;
  /**
   * 方式由调用方单独持有时传入（批量框：`null` = 还没选）；缺省按 `draft.enabled` 推导，
   * 选择落回 `onChange({ enabled })`。
   */
  mode?: MemoryLimitsMode | null;
  onModeChange?: (mode: MemoryLimitsMode) => void;
}

/** 表单本体。单独导出且不带请求：对话框走 portal，静态渲染只看得到这一块。 */
export function MemoryLimitsFields({
  draft,
  errors,
  idPrefix,
  disabled,
  onChange,
  mode = memoryLimitsMode(draft),
  onModeChange,
}: MemoryLimitsFieldsProps) {
  const { t } = useTranslation();
  const fields: readonly FieldItem[] =
    mode === 'custom' ? [...LIMIT_FIELDS, INTERVAL_FIELD] : [INTERVAL_FIELD];
  const selectMode =
    onModeChange ?? ((next: MemoryLimitsMode) => onChange({ enabled: next === 'custom' }));
  return (
    <div className="flex flex-col gap-3" data-testid={`${idPrefix}-form`}>
      <MemoryLimitsModeChooser
        mode={mode}
        idPrefix={idPrefix}
        disabled={disabled}
        onSelect={selectMode}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((item) => (
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
