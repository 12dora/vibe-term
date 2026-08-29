// 本机区块：角色、hub 地址、直连插件开关。
//
// 直连插件的开关只动磁盘（下载 / 删除 `native/`），运行中的 RTC 管理器无法热加载，
// 因此后端恒返回 `restartRequired: true`——这里必须给出「立即重启」并等服务回来，
// 否则用户会以为开关没生效。等待判据是 `/healthz.startedAt` 变了（进程换了）。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { type LocalApi, defaultLocalApi } from '@tmex/api-client/local/local-api';
import type { LocalRole, LocalStatusResponse } from '@tmex/api-client/local/types';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Switch } from '@tmex/ui/switch';
import { Check, Copy, Loader2, RotateCcw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useRestartGateway } from './restart/use-restart-now';

export interface LocalMachineCardProps {
  mode: AuthModeResponse | null;
  status: LocalStatusResponse | null;
  loading: boolean;
  loginRequired: boolean;
  api?: LocalApi;
  client?: ApiClient;
  /** 直连状态变更 / 重启完成后重新拉 `local-status`。 */
  onRefresh: () => void;
}

const ROLE_LABEL_KEY: Record<LocalRole, string> = {
  standalone: 'nodes.machine.roleStandalone',
  node: 'nodes.machine.roleNode',
  'hub,node': 'nodes.machine.roleHub',
};

export function LocalMachineCard({
  mode,
  status,
  loading,
  loginRequired,
  api = defaultLocalApi,
  client = defaultApiClient,
  onRefresh,
}: LocalMachineCardProps) {
  const { t } = useTranslation();
  const meshEnabled = mode?.mode === 'mesh';
  const [directPending, setDirectPending] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  // 重启成功后插件已经加载，横幅必须先撤掉，否则用户会以为还要再重启一次。
  const onRestarted = useCallback(() => {
    setRestartRequired(false);
    onRefresh();
  }, [onRefresh]);
  const restart = useRestartGateway(client, onRestarted);

  const toggleDirect = useCallback(
    async (enable: boolean) => {
      setDirectPending(true);
      try {
        const result = await api.setDirect(enable);
        if (result.restartRequired) setRestartRequired(true);
        onRefresh();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        toast.error(`${t('nodes.machine.directFailed')}${detail ? `: ${detail}` : ''}`);
      } finally {
        setDirectPending(false);
      }
    },
    [api, onRefresh, t]
  );

  return (
    <Card data-testid="local-machine-card">
      <CardHeader>
        <CardTitle>{t('nodes.machine.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loginRequired ? (
          <p className="text-xs text-muted-foreground" data-testid="local-machine-login-required">
            {t('nodes.machine.loginRequired')}
          </p>
        ) : loading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : status ? (
          <>
            <Row label={t('nodes.machine.role')}>
              <Badge variant="secondary" data-testid="local-machine-role">
                {t(ROLE_LABEL_KEY[status.role])}
              </Badge>
            </Row>

            {status.hubUrl && (
              <Row label={t('nodes.machine.hubUrl')}>
                <CopyableValue value={status.hubUrl} testId="local-machine-hub-url" />
              </Row>
            )}
            {status.hubPublicUrl && (
              <Row label={t('nodes.machine.hubPublicUrl')}>
                <CopyableValue value={status.hubPublicUrl} testId="local-machine-hub-public-url" />
              </Row>
            )}

            <Row label={t('nodes.machine.direct')}>
              <div className="flex flex-wrap items-center gap-2">
                {status.direct.supported ? (
                  <>
                    <Badge variant="outline" data-testid="local-machine-direct-supported">
                      {t('nodes.machine.directSupported')}
                    </Badge>
                    <Badge variant="outline" data-testid="local-machine-direct-installed">
                      {status.direct.installed
                        ? t('nodes.machine.directInstalled')
                        : t('nodes.machine.directNotInstalled')}
                    </Badge>
                    {status.direct.capable && (
                      <Badge variant="outline" data-testid="local-machine-direct-capable">
                        {t('nodes.machine.directCapable')}
                      </Badge>
                    )}
                  </>
                ) : (
                  <Badge variant="outline" data-testid="local-machine-direct-unsupported">
                    {t('nodes.machine.directUnsupported')}
                  </Badge>
                )}
                {directPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                <Switch
                  checked={status.direct.installed}
                  disabled={!status.direct.supported || directPending || restart.waiting}
                  onCheckedChange={(checked) => void toggleDirect(Boolean(checked))}
                  data-testid="local-machine-direct-switch"
                />
                <span className="text-xs text-muted-foreground">
                  {status.direct.installed
                    ? t('nodes.machine.directDisable')
                    : t('nodes.machine.directEnable')}
                </span>
              </div>
            </Row>

            {restartRequired && (
              <div
                className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-2 text-xs"
                data-testid="local-machine-restart-required"
              >
                <span className="text-muted-foreground">
                  {restart.state === 'waiting'
                    ? t('nodes.machine.restarting')
                    : restart.state === 'timeout'
                      ? t('nodes.machine.restartTimeout')
                      : t('nodes.machine.directRestartRequired')}
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={restart.waiting}
                  onClick={() => void restart.run()}
                  data-testid="local-machine-restart-now"
                >
                  {restart.waiting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  {t('nodes.machine.restartNow')}
                </Button>
              </div>
            )}
          </>
        ) : null}

        {meshEnabled && (
          <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
            <Link
              to="/nodes"
              className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              data-testid="local-machine-nodes-link"
            >
              {t('nodes.machine.openNodesPage')}
            </Link>
            <Link
              to="/account/security"
              className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              data-testid="local-machine-account-security"
            >
              {t('nodes.machine.accountSecurity')}
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function CopyableValue({ value, testId }: { value: string; testId: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code
        className="min-w-0 break-all rounded bg-muted/50 px-1.5 py-0.5 text-[11px]"
        data-testid={testId}
      >
        {value}
      </code>
      <Button type="button" size="xs" variant="ghost" onClick={copy} data-testid={`${testId}-copy`}>
        {copied ? <Check /> : <Copy />}
        {copied ? t('nodes.actions.copied') : t('nodes.actions.copy')}
      </Button>
    </span>
  );
}
