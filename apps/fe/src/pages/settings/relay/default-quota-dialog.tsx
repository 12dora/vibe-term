// 默认配额对话框：未单独设置配额的租户用这组值。入口在租户卡的「更多」里。

import type { RelayQuota } from '@tmex/api-client/relay/admin-api';
import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';
import { QuotaFields } from './quota-fields';
import { type QuotaDraft, type QuotaErrors, parseQuotaDraft, quotaToDraft } from './relay-forms';

export interface DefaultQuotaDialogProps {
  open: boolean;
  quota: RelayQuota;
  busy: boolean;
  /** 提交失败的原因；成功由调用方关框。 */
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (quota: RelayQuota) => void;
}

/** 对话框正文。单独导出：Dialog 走 portal，静态渲染只看得到这一块。 */
export function DefaultQuotaDialogBody({
  draft,
  errors,
  busy,
  error,
  onChange,
}: {
  draft: QuotaDraft;
  errors: QuotaErrors;
  busy: boolean;
  error: string | null;
  onChange: (patch: Partial<QuotaDraft>) => void;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="relay-default-quota-body">
      <QuotaFields
        idPrefix="relay-default-quota"
        draft={draft}
        errors={errors}
        disabled={busy}
        onChange={onChange}
      />
      {error && (
        <Notice tone="error" testId="relay-default-quota-error">
          {error}
        </Notice>
      )}
    </div>
  );
}

export function DefaultQuotaDialog({
  open,
  quota,
  busy,
  error,
  onOpenChange,
  onSave,
}: DefaultQuotaDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<QuotaDraft>(() => quotaToDraft(quota));
  const [errors, setErrors] = useState<QuotaErrors>({});

  // 每次开框都从服务端当前值起草：上一次没存下的改动不该留到下一次。
  const [lastOpen, setLastOpen] = useState(open);
  if (lastOpen !== open) {
    setLastOpen(open);
    setDraft(quotaToDraft(quota));
    setErrors({});
  }

  const submit = () => {
    const parsed = parseQuotaDraft(draft);
    setErrors(parsed.errors ?? {});
    if (parsed.quota) onSave(parsed.quota);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="relay-default-quota-dialog">
        <DialogHeader>
          <DialogTitle>{t('relay.admin.quota.title')}</DialogTitle>
          <DialogDescription>{t('relay.admin.quota.description')}</DialogDescription>
        </DialogHeader>

        <DefaultQuotaDialogBody
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
            data-testid="relay-default-quota-save"
          >
            {busy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
