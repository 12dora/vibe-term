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
import type { ExposureState } from './exposure';
import type { NamedDraft } from './named-step';
import { TunnelStatusCard } from './status-card';
import { type TunnelActions, useTunnelActions } from './tunnel-actions';
import { isExposureAckError, withExposureAck } from './tunnel-model';
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
  const [acknowledged, setAcknowledged] = useState(false);
  const [hostname, setHostnameValue] = useState('');
  const [tunnelName, setTunnelNameValue] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const { setStatus, refresh } = tunnel;
  const rawActions = useTunnelActions(tunnel.status, { onStatus: setStatus, onRefresh: refresh });

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

  const status = tunnel.status;
  const draft: NamedDraft = {
    hostname,
    tunnelName,
    confirmed,
    // 改主机名等于推翻上一次确认：创建那一步必须重新走一遍。
    setHostname: (value) => {
      setHostnameValue(value);
      setConfirmed(false);
    },
    setTunnelName: (value) => {
      setTunnelNameValue(value);
      setConfirmed(false);
    },
    setConfirmed,
  };
  const exposure: ExposureState = {
    unprotected: !status.exposureProtected,
    acknowledged,
    setAcknowledged,
    ackRequired: isExposureAckError(status, rawActions.error),
  };
  // 开放性动作只有在用户勾了确认之后才带上 `acknowledgeExposure`，否则由后端 409 挡下。
  const actions: TunnelActions = {
    ...rawActions,
    run: (req) => rawActions.run(withExposureAck(req, acknowledged)),
  };

  return (
    <div className="flex w-full flex-col gap-4" data-testid="settings-remote-access-tab">
      <TunnelStatusCard status={status} actions={actions} exposure={exposure} />
      <TunnelWizard
        status={status}
        actions={actions}
        chosenMode={chosenMode}
        onChooseMode={setChosenMode}
        draft={draft}
        isHub={isSelfHub(mode)}
        exposure={exposure}
        onRestarted={refresh}
      />
    </div>
  );
}

/** 本机即 hub：`/api/auth/mode` 下发的 `hubNodeId` 与自身 nodeId 相同。 */
function isSelfHub(mode: AuthModeResponse | null): boolean {
  return mode?.mode === 'mesh' && !!mode.hubNodeId && mode.hubNodeId === mode.nodeId;
}
