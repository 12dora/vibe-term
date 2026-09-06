// 中继限额对话框：作用于中继本身（能接多少租户、总共放行多少带宽），不随配额下发给租户。
// 入口在页头「更多」里，与「修改接入密码」并列。

import type { RelayLimits } from '@vibeterm/api-client/relay/admin-api';
import { Button } from '@vibeterm/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibeterm/ui/dialog';
import { Input } from '@vibeterm/ui/input';
import { Switch } from '@vibeterm/ui/switch';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, Notice } from '../components/form-primitives';
import {
  type LimitsDraft,
  type LimitsErrors,
  MAX_TENANTS_LIMIT,
  TOTAL_BANDWIDTH_KB_LIMIT,
  limitsToDraft,
  parseLimitsDraft,
} from './relay-forms';

export interface RelayLimitsDialogProps {
  open: boolean;
  limits: RelayLimits | undefined;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (limits: RelayLimits) => void;
}

/** 对话框正文。单独导出：Dialog 走 portal，静态渲染只看得到这一块。 */
export function RelayLimitsDialogBody({
  draft,
  errors,
  busy,
  error,
  onChange,
}: {
  draft: LimitsDraft;
  errors: LimitsErrors;
  busy: boolean;
  error: string | null;
  onChange: (patch: Partial<LimitsDraft>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3" data-testid="relay-limits-body">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          id="relay-limits-max-tenants"
          label={t('relay.admin.limits.maxTenants')}
          error={errors.maxTenants ? t(errors.maxTenants, { max: MAX_TENANTS_LIMIT }) : undefined}
          spacing="tight"
        >
          <Input
            id="relay-limits-max-tenants"
            inputMode="numeric"
            placeholder={t('relay.admin.quota.unlimitedValue')}
            value={draft.maxTenants}
            disabled={busy}
            onChange={(event) => onChange({ maxTenants: event.target.value })}
            data-testid="relay-limits-max-tenants"
          />
        </FormField>

        <FormField
          id="relay-limits-bandwidth"
          label={t('relay.admin.limits.totalBandwidth')}
          error={
            errors.totalBandwidthKb
              ? t(errors.totalBandwidthKb, { max: TOTAL_BANDWIDTH_KB_LIMIT })
              : undefined
          }
          spacing="tight"
        >
          <Input
            id="relay-limits-bandwidth"
            inputMode="numeric"
            placeholder={t('relay.admin.quota.unlimitedValue')}
            value={draft.totalBandwidthKb}
            disabled={busy}
            onChange={(event) => onChange({ totalBandwidthKb: event.target.value })}
            data-testid="relay-limits-bandwidth"
          />
        </FormField>
      </div>

      <FormField
        id="relay-limits-fair-share"
        label={t('relay.admin.limits.fairShare')}
        hint={t('relay.admin.limits.fairShareHint')}
        spacing="tight"
      >
        <Switch
          id="relay-limits-fair-share"
          checked={draft.fairShare}
          disabled={busy}
          aria-label={t('relay.admin.limits.fairShare')}
          onCheckedChange={(next) => onChange({ fairShare: next === true })}
          data-testid="relay-limits-fair-share"
        />
      </FormField>

      {error && (
        <Notice tone="error" testId="relay-limits-error">
          {error}
        </Notice>
      )}
    </div>
  );
}

export function RelayLimitsDialog({
  open,
  limits,
  busy,
  error,
  onOpenChange,
  onSave,
}: RelayLimitsDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<LimitsDraft>(() => limitsToDraft(limits));
  const [errors, setErrors] = useState<LimitsErrors>({});

  // 每次开框都从服务端当前值起草：上一次没存下的改动不该留到下一次。
  const [lastOpen, setLastOpen] = useState(open);
  if (lastOpen !== open) {
    setLastOpen(open);
    setDraft(limitsToDraft(limits));
    setErrors({});
  }

  const submit = () => {
    const parsed = parseLimitsDraft(draft);
    setErrors(parsed.errors ?? {});
    if (parsed.limits) onSave(parsed.limits);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="relay-limits-dialog">
        <DialogHeader>
          <DialogTitle>{t('relay.admin.limits.title')}</DialogTitle>
          <DialogDescription>{t('relay.admin.limits.description')}</DialogDescription>
        </DialogHeader>

        <RelayLimitsDialogBody
          draft={draft}
          errors={errors}
          busy={busy}
          error={error}
          onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
        />

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={submit}
            data-testid="relay-limits-save"
          >
            {busy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
