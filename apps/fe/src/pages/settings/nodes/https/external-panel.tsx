// 外部反代模式：TLS 由 Cloudflare Tunnel / nginx / caddy 终止，tmex 只保留明文监听。
//
// 唯一的开关是 `trustProxy`——它写进 env 文件，只有换进程才生效，因此保存后会出现重启提示。

import type { TlsStatusResponse } from '@tmex/api-client/local/tls-types';
import { Button } from '@tmex/ui/button';
import { Switch } from '@tmex/ui/switch';
import { Loader2, Save } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from './parts';

export function ExternalPanel({
  status,
  busy,
  savePending,
  onSave,
}: {
  status: TlsStatusResponse;
  /** 保存 / 续签 / ACME 签发进行中：整个面板只读。 */
  busy: boolean;
  savePending: boolean;
  onSave: (trustProxy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [trustProxy, setTrustProxy] = useState(status.trustProxy);
  // 已经在经反代的 HTTPS 上访问，但 tmex 还没信任代理头：此时协议判断只能靠公开地址推断。
  const unverified =
    status.https?.source === 'reverse-proxy' && !status.https.verified && !status.trustProxy;

  return (
    <div className="space-y-3" data-testid="https-external-panel">
      <p className="text-xs text-muted-foreground">{t('nodes.https.external.intro')}</p>

      {unverified && (
        <Notice tone="info" testId="https-external-effective">
          <p>{t('nodes.https.effective.externalUnverified')}</p>
        </Notice>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <label className="block text-sm font-medium" htmlFor="https-trust-proxy">
            {t('nodes.https.external.trustProxy')}
          </label>
          <p className="text-xs text-muted-foreground">
            {t('nodes.https.external.trustProxyHint')}
          </p>
        </div>
        <Switch
          id="https-trust-proxy"
          data-testid="https-trust-proxy"
          checked={trustProxy}
          disabled={busy}
          onCheckedChange={(next) => setTrustProxy(Boolean(next))}
        />
      </div>

      <Notice tone={trustProxy ? 'warning' : 'info'} testId="https-trust-proxy-detail">
        <p>{t('nodes.https.external.trustProxyDetail')}</p>
      </Notice>

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => onSave(trustProxy)}
          data-testid="https-external-save"
        >
          {savePending ? <Loader2 className="animate-spin" /> : <Save />}
          {t('nodes.https.save')}
        </Button>
      </div>
    </div>
  );
}
