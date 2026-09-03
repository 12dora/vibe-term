// 配额三件套（节点数 / 并发流 / 带宽）的字段组：默认配额表单与单租户覆盖共用。

import { Input } from '@tmex/ui/input';
import { Switch } from '@tmex/ui/switch';
import { useTranslation } from 'react-i18next';
import { FormField } from '../components/form-primitives';
import type { QuotaDraft, QuotaErrors } from './relay-forms';

export interface QuotaFieldsProps {
  /** 字段 id 前缀：同一页里可能同时存在默认配额与租户配额两组。 */
  idPrefix: string;
  draft: QuotaDraft;
  errors: QuotaErrors;
  disabled?: boolean;
  onChange: (patch: Partial<QuotaDraft>) => void;
}

export function QuotaFields({ idPrefix, draft, errors, disabled, onChange }: QuotaFieldsProps) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FormField
        id={`${idPrefix}-max-nodes`}
        label={t('relay.admin.quota.maxNodes')}
        error={errors.maxNodes ? t(errors.maxNodes) : undefined}
        spacing="tight"
      >
        <Input
          id={`${idPrefix}-max-nodes`}
          inputMode="numeric"
          value={draft.maxNodes}
          disabled={disabled}
          onChange={(event) => onChange({ maxNodes: event.target.value })}
          data-testid={`${idPrefix}-max-nodes`}
        />
      </FormField>

      <FormField
        id={`${idPrefix}-max-streams`}
        label={t('relay.admin.quota.maxStreams')}
        error={errors.maxStreams ? t(errors.maxStreams) : undefined}
        spacing="tight"
      >
        <Input
          id={`${idPrefix}-max-streams`}
          inputMode="numeric"
          value={draft.maxStreams}
          disabled={disabled}
          onChange={(event) => onChange({ maxStreams: event.target.value })}
          data-testid={`${idPrefix}-max-streams`}
        />
      </FormField>

      <div className="sm:col-span-2">
        <FormField
          id={`${idPrefix}-bandwidth`}
          label={t('relay.admin.quota.bandwidth')}
          error={errors.bandwidthKb ? t(errors.bandwidthKb) : undefined}
          spacing="tight"
        >
          <div className="flex flex-wrap items-center gap-3">
            <Input
              id={`${idPrefix}-bandwidth`}
              inputMode="numeric"
              className="sm:max-w-40"
              value={draft.bandwidthKb}
              disabled={disabled || draft.unlimited}
              onChange={(event) => onChange({ bandwidthKb: event.target.value })}
              data-testid={`${idPrefix}-bandwidth`}
            />
            <label
              className="flex items-center gap-2 text-xs text-muted-foreground"
              htmlFor={`${idPrefix}-unlimited`}
            >
              <Switch
                id={`${idPrefix}-unlimited`}
                checked={draft.unlimited}
                disabled={disabled}
                aria-label={t('relay.admin.quota.unlimited')}
                onCheckedChange={(next) => onChange({ unlimited: next === true })}
                data-testid={`${idPrefix}-unlimited`}
              />
              {t('relay.admin.quota.unlimited')}
            </label>
          </div>
        </FormField>
      </div>
    </div>
  );
}
