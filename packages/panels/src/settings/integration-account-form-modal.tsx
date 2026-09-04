import { useMutation, useQueryClient } from '@tanstack/react-query';
import { parseApiError } from '@tmex/api-client';
import { useRuntime } from '@tmex/stores/react';
import type { TFunction } from 'i18next';
import { Loader2, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@tmex/ui/dialog';
import { Input } from '@tmex/ui/input';
import { Switch } from '@tmex/ui/switch';

const FIELD_CLASS = 'min-h-10';

export type IntegrationFieldValue = string | boolean;
export type IntegrationFormValues = Record<string, IntegrationFieldValue>;

export interface IntegrationFormContext {
  isEdit: boolean;
}

interface IntegrationFieldBase<TEntity> {
  key: string;
  inputId: string;
  testId: string;
  labelKey: string;
  /** 补充说明，渲染在标签下方一行 */
  descriptionKey?: string;
  initialValue: (entity: TEntity | undefined) => IntegrationFieldValue;
  validate?: (value: IntegrationFieldValue, ctx: IntegrationFormContext) => boolean;
}

interface IntegrationTextField<TEntity> extends IntegrationFieldBase<TEntity> {
  kind: 'text' | 'secret';
  placeholderKey: string | ((ctx: IntegrationFormContext) => string);
  initialValue: (entity: TEntity | undefined) => string;
}

interface IntegrationToggleField<TEntity> extends IntegrationFieldBase<TEntity> {
  kind: 'toggle';
  initialValue: (entity: TEntity | undefined) => boolean;
}

export type IntegrationField<TEntity> =
  | IntegrationTextField<TEntity>
  | IntegrationToggleField<TEntity>;

export interface IntegrationFormConfig<TEntity extends { id: string }> {
  testIdPrefix: string;
  queryKey: readonly unknown[];
  addTitleKey: string;
  editTitleKey: string;
  fields: IntegrationField<TEntity>[];
  buildPayload: (
    values: IntegrationFormValues,
    ctx: IntegrationFormContext
  ) => Record<string, unknown>;
  create: {
    path: string;
    errorFallbackKey: string;
    successToastKey: string;
    readResponse?: boolean;
  };
  update: {
    path: (entity: TEntity) => string;
    errorFallbackKey: string;
    successToastKey: string;
  };
}

export function integrationInitialValues<TEntity>(
  fields: IntegrationField<TEntity>[],
  entity: TEntity | undefined
): IntegrationFormValues {
  const values: IntegrationFormValues = {};
  for (const field of fields) {
    values[field.key] = field.initialValue(entity);
  }
  return values;
}

export function integrationCanSubmit<TEntity>(
  fields: IntegrationField<TEntity>[],
  values: IntegrationFormValues,
  ctx: IntegrationFormContext
): boolean {
  return fields.every((field) => field.validate?.(values[field.key], ctx) ?? true);
}

export function nonEmptyText(value: IntegrationFieldValue): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

interface IntegrationAccountFormModalProps<TEntity extends { id: string }> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: IntegrationFormConfig<TEntity>;
  /** 缺省表示新增模式 */
  entity?: TEntity;
  onCreated?: (ctx: { response: unknown; values: IntegrationFormValues }) => void;
}

export function IntegrationFormFields<TEntity>({
  fields,
  values,
  setValue,
  isEdit,
}: {
  fields: IntegrationField<TEntity>[];
  values: IntegrationFormValues;
  setValue: (key: string, next: IntegrationFieldValue) => void;
  isEdit: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      {fields.map((field) => renderField(field, values[field.key], setValue, { isEdit }, t))}
    </div>
  );
}

/**
 * 开关字段。`id` 落在 Base UI Switch 内部那个真正的 checkbox 上，因此 `<label htmlFor>` 点一下
 * 就能切；`role="switch"` 的那层是另一个元素，可访问名与说明只能靠 `aria-labelledby` /
 * `aria-describedby` 显式接上。
 */
function renderToggleField<TEntity>(
  field: IntegrationField<TEntity>,
  value: IntegrationFieldValue,
  setValue: (key: string, next: IntegrationFieldValue) => void,
  t: TFunction
) {
  const labelId = `${field.inputId}-label`;
  const descriptionId = field.descriptionKey ? `${field.inputId}-description` : undefined;
  return (
    <div
      key={field.key}
      className={cn(
        'flex min-h-10 justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5',
        field.descriptionKey ? 'items-start' : 'items-center'
      )}
    >
      <div className="min-w-0">
        <label
          id={labelId}
          htmlFor={field.inputId}
          className="block text-sm font-medium cursor-pointer"
        >
          {t(field.labelKey)}
        </label>
        {field.descriptionKey && (
          <p
            id={descriptionId}
            className="mt-1 text-xs leading-snug text-muted-foreground"
            data-testid={`${field.testId}-help`}
          >
            {t(field.descriptionKey)}
          </p>
        )}
      </div>
      <Switch
        id={field.inputId}
        checked={Boolean(value)}
        data-testid={field.testId}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        className={cn('shrink-0', field.descriptionKey && 'mt-0.5')}
        onCheckedChange={(checked) => setValue(field.key, Boolean(checked))}
      />
    </div>
  );
}

function renderField<TEntity>(
  field: IntegrationField<TEntity>,
  value: IntegrationFieldValue,
  setValue: (key: string, next: IntegrationFieldValue) => void,
  ctx: IntegrationFormContext,
  t: TFunction
) {
  if (field.kind === 'toggle') {
    return renderToggleField(field, value, setValue, t);
  }

  return (
    <div key={field.key} className="space-y-1.5">
      <label className="block text-sm font-medium" htmlFor={field.inputId}>
        {t(field.labelKey)}
      </label>
      <Input
        id={field.inputId}
        data-testid={field.testId}
        type={field.kind === 'secret' ? 'password' : undefined}
        value={String(value)}
        onChange={(event) => setValue(field.key, event.target.value)}
        placeholder={t(
          typeof field.placeholderKey === 'function'
            ? field.placeholderKey(ctx)
            : field.placeholderKey
        )}
        className={FIELD_CLASS}
      />
    </div>
  );
}

function useIntegrationSubmit<TEntity extends { id: string }>({
  config,
  entity,
  values,
  onOpenChange,
  onCreated,
}: {
  config: IntegrationFormConfig<TEntity>;
  entity: TEntity | undefined;
  values: IntegrationFormValues;
  onOpenChange: (open: boolean) => void;
  onCreated?: (ctx: { response: unknown; values: IntegrationFormValues }) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { apiClient } = useRuntime();

  const mutation = useMutation({
    mutationFn: async () => {
      const target = entity
        ? {
            method: 'PATCH',
            path: config.update.path(entity),
            fallbackKey: config.update.errorFallbackKey,
            readResponse: false,
          }
        : {
            method: 'POST',
            path: config.create.path,
            fallbackKey: config.create.errorFallbackKey,
            readResponse: Boolean(config.create.readResponse),
          };
      const res = await apiClient.fetch(target.path, {
        method: target.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config.buildPayload(values, { isEdit: Boolean(entity) })),
      });
      if (!res.ok) {
        throw new Error(await parseApiError(res, t(target.fallbackKey)));
      }
      return target.readResponse ? await res.json() : undefined;
    },
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: config.queryKey });
      toast.success(t(entity ? config.update.successToastKey : config.create.successToastKey));
      onOpenChange(false);
      if (!entity) {
        onCreated?.({ response, values });
      }
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return { isPending: mutation.isPending, submit: () => mutation.mutate() };
}

export function IntegrationAccountFormModal<TEntity extends { id: string }>({
  open,
  onOpenChange,
  config,
  entity,
  onCreated,
}: IntegrationAccountFormModalProps<TEntity>) {
  const { t } = useTranslation();
  const isEdit = Boolean(entity);

  const [values, setValues] = useState<IntegrationFormValues>(() =>
    integrationInitialValues(config.fields, entity)
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setValues(integrationInitialValues(config.fields, entity));
  }, [open, entity, config]);

  const setValue = (key: string, next: IntegrationFieldValue) => {
    setValues((prev) => ({ ...prev, [key]: next }));
  };

  const { isPending, submit } = useIntegrationSubmit({
    config,
    entity,
    values,
    onOpenChange,
    onCreated,
  });
  const canSubmit = integrationCanSubmit(config.fields, values, { isEdit });

  const handleSubmit = () => {
    if (!canSubmit || isPending) {
      return;
    }
    submit();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid={
          isEdit
            ? `${config.testIdPrefix}-edit-modal-${entity?.id}`
            : `${config.testIdPrefix}-add-modal`
        }
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? t(config.editTitleKey) : t(config.addTitleKey)}</DialogTitle>
        </DialogHeader>

        <IntegrationFormFields
          fields={config.fields}
          values={values}
          setValue={setValue}
          isEdit={isEdit}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            data-testid={`${config.testIdPrefix}-form-submit`}
            onClick={handleSubmit}
            disabled={!canSubmit || isPending}
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
