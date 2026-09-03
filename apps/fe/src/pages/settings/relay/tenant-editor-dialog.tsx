// 单租户编辑：备注 + 配额（可「跟随默认」）。

import type {
  RelayQuota,
  RelayTenantPatch,
  RelayTenantSummary,
} from '@tmex/api-client/relay/admin-api';
import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Input } from '@tmex/ui/input';
import { Switch } from '@tmex/ui/switch';
import { Loader2, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, Notice } from '../components/form-primitives';
import { QuotaFields } from './quota-fields';
import { type QuotaErrors, type TenantDraft, parseTenantDraft, tenantToDraft } from './relay-forms';

export interface TenantEditorDialogProps {
  tenant: RelayTenantSummary | null;
  defaultQuota: RelayQuota;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (patch: RelayTenantPatch) => void;
}

/** 对话框正文。单独导出：Dialog 走 portal，静态渲染只看得到这一块。 */
export function TenantEditorBody({
  draft,
  errors,
  error,
  busy,
  onChange,
}: {
  draft: TenantDraft;
  errors: QuotaErrors;
  error: string | null;
  busy: boolean;
  onChange: (patch: Partial<TenantDraft>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4" data-testid="relay-tenant-editor-body">
      <FormField id="relay-tenant-label" label={t('relay.admin.tenants.label')} spacing="tight">
        <Input
          id="relay-tenant-label"
          value={draft.label}
          disabled={busy}
          placeholder={t('relay.admin.tenants.labelPlaceholder')}
          onChange={(event) => onChange({ label: event.target.value })}
          data-testid="relay-tenant-label"
        />
      </FormField>

      <label
        className="flex items-center justify-between gap-3 text-sm"
        htmlFor="relay-tenant-inherit"
      >
        <span className="font-medium">{t('relay.admin.quota.inherit')}</span>
        <Switch
          id="relay-tenant-inherit"
          checked={draft.inherit}
          disabled={busy}
          aria-label={t('relay.admin.quota.inherit')}
          onCheckedChange={(next) => onChange({ inherit: next === true })}
          data-testid="relay-tenant-inherit"
        />
      </label>

      <QuotaFields
        idPrefix="relay-tenant-quota"
        draft={draft.quota}
        errors={errors}
        disabled={busy || draft.inherit}
        onChange={(patch) => onChange({ quota: { ...draft.quota, ...patch } })}
      />

      {error && (
        <Notice tone="error" testId="relay-tenant-editor-error">
          {error}
        </Notice>
      )}
    </div>
  );
}

export function TenantEditorDialog({
  tenant,
  defaultQuota,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: TenantEditorDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<TenantDraft | null>(null);
  const [errors, setErrors] = useState<QuotaErrors>({});

  // 换一个租户（或重新打开）就重建草稿，绝不把上一位的配额带过来。
  useEffect(() => {
    setDraft(tenant ? tenantToDraft(tenant, defaultQuota) : null);
    setErrors({});
  }, [tenant, defaultQuota]);

  if (!tenant || !draft) return null;

  const submit = () => {
    const parsed = parseTenantDraft(draft);
    setErrors(parsed.errors ?? {});
    if (parsed.patch) onSubmit(parsed.patch);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="relay-tenant-editor-dialog">
        <DialogHeader>
          <DialogTitle>{t('relay.admin.tenants.editTitle')}</DialogTitle>
          <DialogDescription className="font-mono break-all">{tenant.id}</DialogDescription>
        </DialogHeader>

        <TenantEditorBody
          draft={draft}
          errors={errors}
          error={error}
          busy={busy}
          onChange={(patch) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev))}
        />

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={submit}
            data-testid="relay-tenant-editor-save"
          >
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Save />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
