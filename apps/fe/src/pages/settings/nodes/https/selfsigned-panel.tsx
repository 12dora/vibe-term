// 自签模式：本机生成一个私有 CA（一次性，10 年），再用它签 398 天的叶证书。
//
// 浏览器默认不认这个 CA，因此保存成功后必须把「下载 CA + 各端安装」摆在显眼位置，
// 否则用户只会看到一个证书错误页。

import type { TlsStatusResponse } from '@tmex/api-client/local/tls-types';
import { Button } from '@tmex/ui/button';
import { Download, Loader2, RefreshCw, Save } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaInstallGuide } from './ca-install-guide';
import { CopyableCode, ListenerFields, Notice } from './parts';
import { SansEditor } from './sans-editor';
import { validateBindHost, validatePort, validateSans } from './tls-form';

export interface SelfSignedDraft {
  sans: string[];
  tlsPort: string;
  bindHost: string;
}

interface DraftErrors {
  sans?: string;
  port?: string;
  host?: string;
}

export function SelfSignedPanel({
  status,
  initialSans,
  caUrl,
  busy,
  savePending,
  renewPending,
  onSave,
  onRenew,
}: {
  status: TlsStatusResponse;
  /** 首次配置时的预填 SAN（取地址栏主机名，回环地址不预填）。 */
  initialSans: string[];
  caUrl: string;
  /** 保存 / 续签 / ACME 签发进行中：整个面板只读。 */
  busy: boolean;
  savePending: boolean;
  renewPending: boolean;
  onSave: (draft: { sans: string[]; tlsPort: number; bindHost: string }) => void;
  onRenew: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SelfSignedDraft>(() => ({
    sans: status.sans.length > 0 ? status.sans : initialSans,
    tlsPort: String(status.tlsPort),
    bindHost: status.bindHost,
  }));
  const [errors, setErrors] = useState<DraftErrors>({});

  const issued = status.mode === 'selfsigned' && Boolean(status.caFingerprint);

  const submit = () => {
    const next: DraftErrors = {};
    const sansError = validateSans(draft.sans);
    if (sansError) next.sans = sansError;
    const portError = validatePort(draft.tlsPort);
    if (portError) next.port = portError;
    const hostError = validateBindHost(draft.bindHost);
    if (hostError) next.host = hostError;
    setErrors(next);
    if (sansError || portError || hostError) return;
    onSave({
      sans: draft.sans,
      tlsPort: Number(draft.tlsPort.trim()),
      bindHost: draft.bindHost.trim(),
    });
  };

  return (
    <div className="space-y-3" data-testid="https-selfsigned-panel">
      <p className="text-xs text-muted-foreground">{t('nodes.https.selfsigned.intro')}</p>

      <SansEditor
        sans={draft.sans}
        disabled={busy}
        {...(errors.sans ? { error: t(errors.sans) } : {})}
        onChange={(sans) => setDraft((prev) => ({ ...prev, sans }))}
      />

      <ListenerFields
        idPrefix="https-selfsigned"
        port={draft.tlsPort}
        bindHost={draft.bindHost}
        disabled={busy}
        {...(errors.port ? { portError: t(errors.port) } : {})}
        {...(errors.host ? { hostError: t(errors.host) } : {})}
        onPortChange={(tlsPort) => setDraft((prev) => ({ ...prev, tlsPort }))}
        onBindHostChange={(bindHost) => setDraft((prev) => ({ ...prev, bindHost }))}
      />

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={submit}
          data-testid="https-selfsigned-save"
        >
          {savePending ? <Loader2 className="animate-spin" /> : <Save />}
          {t('nodes.https.save')}
        </Button>
      </div>

      {issued && (
        <div className="space-y-2 rounded-lg bg-muted/40 p-3" data-testid="https-ca-block">
          <Notice tone="warning">
            <p>{t('nodes.https.selfsigned.trustWarning')}</p>
          </Notice>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs text-muted-foreground">
              {t('nodes.https.selfsigned.fingerprint')}
            </span>
            <CopyableCode value={status.caFingerprint ?? ''} testId="https-ca-fingerprint" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={caUrl}
              download="tmex-ca.crt"
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium hover:bg-muted"
              data-testid="https-ca-download"
            >
              <Download className="size-3.5" />
              {t('nodes.https.selfsigned.downloadCa')}
            </a>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onRenew}
              data-testid="https-selfsigned-renew"
            >
              {renewPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t('nodes.https.selfsigned.renew')}
            </Button>
          </div>
          <CaInstallGuide />
        </div>
      )}
    </div>
  );
}
