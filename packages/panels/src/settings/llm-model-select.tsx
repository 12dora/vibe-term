import type { LlmProviderDto } from '@vibeterm/shared';
import { cn } from '@vibeterm/ui';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@vibeterm/ui/select';
import { useTranslation } from 'react-i18next';
import { decodeModelValue, encodeModelValue } from '../agent/model-value';

export const NONE_MODEL_VALUE = '__none_model__';

export interface LlmModelOptionGroup {
  providerId: string;
  providerName: string;
  models: string[];
}

export function buildLlmModelGroups(providers: LlmProviderDto[]): LlmModelOptionGroup[] {
  return providers
    .filter((provider) => provider.enabled && provider.models.length > 0)
    .map((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      models: provider.models,
    }));
}

export function isModelSelectable(
  groups: LlmModelOptionGroup[],
  providerId: string | null,
  modelId: string | null
): boolean {
  if (!modelId) return false;
  return groups.some((group) => group.providerId === providerId && group.models.includes(modelId));
}

/** 下拉项的 value 还原成 providerId + modelId；none 项清空两者 */
export function resolveModelSelection(value: string): {
  providerId: string | null;
  modelId: string | null;
} {
  if (value === NONE_MODEL_VALUE) return { providerId: null, modelId: null };
  const decoded = decodeModelValue(value);
  return { providerId: decoded.providerId, modelId: decoded.modelId };
}

export interface LlmModelSelectProps {
  providers: LlmProviderDto[];
  providerId: string | null;
  modelId: string | null;
  onChange: (next: { providerId: string | null; modelId: string | null }) => void;
  disabled?: boolean;
  id?: string;
  testId?: string;
  allowNone?: boolean;
  /** allowNone 项的文案，缺省为「未设置」 */
  noneLabel?: string;
  className?: string;
}

/** 按提供商分组的模型选择器：选中即同时写入 providerId 与 modelId */
export function LlmModelSelect({
  providers,
  providerId,
  modelId,
  onChange,
  disabled,
  id,
  testId,
  allowNone,
  noneLabel,
  className,
}: LlmModelSelectProps) {
  const { t } = useTranslation();

  const groups = buildLlmModelGroups(providers);
  const isEmpty = groups.length === 0;
  const selectable = isModelSelectable(groups, providerId, modelId);
  const currentValue = modelId ? encodeModelValue(providerId, modelId) : NONE_MODEL_VALUE;

  const noneText = noneLabel ?? t('common.llmModel.none');
  const placeholder = isEmpty ? t('common.llmModel.empty') : t('common.llmModel.placeholder');

  const triggerLabel = modelId
    ? selectable
      ? modelId
      : t('common.llmModel.unavailable', { model: modelId })
    : allowNone
      ? noneText
      : placeholder;

  return (
    <Select
      value={currentValue}
      onValueChange={(value) => {
        if (typeof value !== 'string' || !value) return;
        onChange(resolveModelSelection(value));
      }}
      disabled={disabled || isEmpty}
    >
      <SelectTrigger id={id} data-testid={testId} className={cn('h-9 w-full', className)}>
        <span className={cn('min-w-0 truncate', modelId ? undefined : 'text-muted-foreground')}>
          {triggerLabel}
        </span>
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE_MODEL_VALUE}>{noneText}</SelectItem>}
        {modelId && !selectable && (
          <SelectItem value={currentValue} className="text-muted-foreground">
            {t('common.llmModel.unavailable', { model: modelId })}
          </SelectItem>
        )}
        {groups.map((group) => (
          <SelectGroup key={group.providerId}>
            <SelectLabel>{group.providerName}</SelectLabel>
            {group.models.map((model) => (
              <SelectItem
                key={`${group.providerId}:${model}`}
                value={encodeModelValue(group.providerId, model)}
              >
                {model}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
