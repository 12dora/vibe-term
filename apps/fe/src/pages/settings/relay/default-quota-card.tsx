// 默认配额卡：未单独设置配额的租户用这组值。

import type { RelayQuota } from '@tmex/api-client/relay/admin-api';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import { Loader2, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';
import { QuotaFields } from './quota-fields';
import { type QuotaDraft, type QuotaErrors, parseQuotaDraft, quotaToDraft } from './relay-forms';

export interface DefaultQuotaCardProps {
  quota: RelayQuota;
  busy: boolean;
  error: string | null;
  onSave: (quota: RelayQuota) => void;
}

export function DefaultQuotaCard({ quota, busy, error, onSave }: DefaultQuotaCardProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<QuotaDraft>(() => quotaToDraft(quota));
  const [errors, setErrors] = useState<QuotaErrors>({});

  // 服务端的值变了（自己刚存完，或轮询拉到别处的改动）就重置草稿；正在提交时不动。
  useEffect(() => {
    if (!busy) setDraft(quotaToDraft(quota));
  }, [quota, busy]);

  const submit = () => {
    const parsed = parseQuotaDraft(draft);
    setErrors(parsed.errors ?? {});
    if (parsed.quota) onSave(parsed.quota);
  };

  return (
    <Card data-testid="relay-default-quota-card">
      <CardHeader>
        <CardTitle>{t('relay.admin.quota.title')}</CardTitle>
        <CardDescription>{t('relay.admin.quota.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <QuotaFields
          idPrefix="relay-default-quota"
          draft={draft}
          errors={errors}
          disabled={busy}
          onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
        />
        {error && (
          <Notice tone="error" testId="relay-default-quota-error">
            {error}
          </Notice>
        )}
        <div className="flex justify-end">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={submit}
            data-testid="relay-default-quota-save"
            className="w-full sm:w-auto"
          >
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Save />}
            {t('common.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
