// 设置页「远程访问」标签：用 Cloudflare Tunnel 把本机的 tmex 暴露到公网。
//
// `/api/tunnel/*` 与 TLS / LocalApi 一样只作用于浏览器直连的那台机器：它要落盘二进制、写 env、
// 起常驻进程，经 `/n/<id>` 转发过去只会改到入口机自己。因此浏览远端 node 时整块不渲染，只给提示。

import { useSharedAuthMode } from '@/node/mesh-nodes';
import { useRouteNodeId } from '@/node/node-runtime-boundary';
import { isSelfNode } from '@tmex/api-client';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import type { TunnelMode } from '@tmex/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SetupNotice } from '../nodes/setup/form-parts';
import { TunnelStatusCard } from './status-card';
import { useTunnelActions } from './tunnel-actions';
import { useTunnelStatus } from './use-tunnel-status';
import { TunnelWizard } from './wizard';

export function RemoteAccessTab() {
  const routeNodeId = useRouteNodeId();
  if (!isSelfNode(routeNodeId)) return <RemoteNodeNotice />;
  return <SelfRemoteAccess />;
}

function RemoteNodeNotice() {
  const { t } = useTranslation();
  return (
    <Card data-testid="settings-remote-access-tab">
      <CardHeader>
        <CardTitle>{t('settings.remoteAccess.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <SetupNotice tone="info" testId="remote-access-remote-node">
          {t('settings.remoteAccess.remoteNodeNotice')}
        </SetupNotice>
      </CardContent>
    </Card>
  );
}

function SelfRemoteAccess() {
  const { t } = useTranslation();
  const tunnel = useTunnelStatus();
  const { mode } = useSharedAuthMode();
  const [chosenMode, setChosenMode] = useState<TunnelMode | null>(null);

  const { setStatus, refresh } = tunnel;
  const actions = useTunnelActions(tunnel.status, { onStatus: setStatus, onRefresh: refresh });

  if (tunnel.loginRequired) {
    return (
      <Card data-testid="settings-remote-access-tab">
        <CardHeader>
          <CardTitle>{t('settings.remoteAccess.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground" data-testid="remote-access-login-required">
            {t('settings.remoteAccess.loginRequired')}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (tunnel.loading) {
    return (
      <div
        className="flex h-9 items-center px-1 text-muted-foreground"
        data-testid="settings-remote-access-tab"
      >
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (!tunnel.status) {
    return (
      <Card data-testid="settings-remote-access-tab">
        <CardHeader>
          <CardTitle>{t('settings.remoteAccess.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <SetupNotice tone="error" testId="remote-access-load-failed">
            {tunnel.error ?? t('settings.remoteAccess.loadFailed')}
          </SetupNotice>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4" data-testid="settings-remote-access-tab">
      <TunnelStatusCard status={tunnel.status} actions={actions} />
      <TunnelWizard
        status={tunnel.status}
        actions={actions}
        chosenMode={chosenMode}
        onChooseMode={setChosenMode}
        isHub={isSelfHub(mode)}
        onRestarted={refresh}
      />
    </div>
  );
}

/** 本机即 hub：`/api/auth/mode` 下发的 `hubNodeId` 与自身 nodeId 相同。 */
function isSelfHub(mode: AuthModeResponse | null): boolean {
  return mode?.mode === 'mesh' && !!mode.hubNodeId && mode.hubNodeId === mode.nodeId;
}
