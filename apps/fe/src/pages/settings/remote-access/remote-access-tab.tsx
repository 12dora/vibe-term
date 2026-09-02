// 设置页「远程访问」标签：把本机的 tmex 开放到外网，走 Cloudflare Tunnel 或直接连接两条路径之一。
//
// `/api/tunnel/*` 与 TLS / LocalApi 一样只作用于浏览器直连的那台机器：它要落盘二进制、写 env、
// 起常驻进程，经 `/n/<id>` 转发过去只会改到入口机自己。因此浏览远端 node 时整块不渲染，只给提示。

import { useSharedAuthMode } from '@/node/mesh-nodes';
import { useRouteNodeId } from '@/node/node-runtime-boundary';
import { isSelfNode } from '@tmex/api-client';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import type { LocalAuthStatus, TunnelStatusResponse } from '@tmex/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SetupNotice } from '../nodes/setup/form-parts';
import { type ExposureState, protectionSnapshot } from './exposure';
import type { NamedDraft } from './named-step';
import { TunnelStatusCard } from './status-card';
import { useTunnelActions } from './tunnel-actions';
import {
  type ConnectionPath,
  type WizardMode,
  effectivePath,
  isExposureAckError,
} from './tunnel-model';
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
  const [chosenPath, setChosenPath] = useState<ConnectionPath | null>(null);
  const [chosenMode, setChosenMode] = useState<WizardMode | null>(null);
  // 开关本机登录后接口会带回最新状态：就地覆盖，`/api/auth/mode` 的共享快照是进程级缓存，拉不动。
  const [localAuthOverride, setLocalAuthOverride] = useState<LocalAuthStatus | null>(null);
  // 暴露确认逐条警示记，勾一条只算一条：这里只存「当前勾上的是哪一条」。
  const [ackedId, setAckedId] = useState<string | null>(null);
  const [hostname, setHostnameValue] = useState('');
  const [tunnelName, setTunnelNameValue] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  useResetOnTunnelRemoved(tunnel.status?.config.mode ?? null, () => {
    setChosenPath(null);
    setChosenMode(null);
    setHostnameValue('');
    setTunnelNameValue('');
    setConfirmed(false);
    setAckedId(null);
  });

  const { setStatus, refresh } = tunnel;
  const actions = useTunnelActions(tunnel.status, { onStatus: setStatus, onRefresh: refresh });
  useClearAckOnProtectionChange(tunnel.status, setAckedId);

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
    ackRequired: isExposureAckError(status, actions.error),
    ackedId,
    setAckedId,
  };

  // 状态卡讲的全是隧道：还没选或选了「直接连接」时它只会让人以为直连也要先建隧道。
  const showStatus = effectivePath(status, chosenPath) === 'tunnel';

  return (
    <div className="flex w-full flex-col gap-4" data-testid="settings-remote-access-tab">
      {showStatus && <TunnelStatusCard status={status} actions={actions} exposure={exposure} />}
      <TunnelWizard
        status={status}
        actions={actions}
        chosenPath={chosenPath}
        onChoosePath={setChosenPath}
        chosenMode={chosenMode}
        onChooseMode={setChosenMode}
        draft={draft}
        isHub={isSelfHub(mode)}
        exposure={exposure}
        onRestarted={refresh}
        localAuth={localAuthOverride ?? mode?.localAuth ?? null}
        onLocalAuth={setLocalAuthOverride}
      />
    </div>
  );
}

/** 保护状态或隧道运行态一变，之前勾的确认就不再对应任何动作：立即作废。 */
function useClearAckOnProtectionChange(
  status: TunnelStatusResponse | null,
  clear: (id: string | null) => void
): void {
  const snapshot = status ? protectionSnapshot(status) : null;
  const previousRef = useRef(snapshot);
  const clearRef = useRef(clear);
  clearRef.current = clear;
  useEffect(() => {
    if (previousRef.current === snapshot) return;
    previousRef.current = snapshot;
    clearRef.current(null);
  }, [snapshot]);
}

/** 隧道被移除（配置回到 off）后，本地选择与草稿都不再成立：整套向导状态归零，重新从连接方式选起。 */
function useResetOnTunnelRemoved(configuredMode: string | null, reset: () => void): void {
  const previousModeRef = useRef(configuredMode);
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    const previous = previousModeRef.current;
    previousModeRef.current = configuredMode;
    if (previous !== null && previous !== 'off' && configuredMode === 'off') resetRef.current();
  }, [configuredMode]);
}

/** 本机即 hub：`/api/auth/mode` 下发的 `hubNodeId` 与自身 nodeId 相同。 */
function isSelfHub(mode: AuthModeResponse | null): boolean {
  return mode?.mode === 'mesh' && !!mode.hubNodeId && mode.hubNodeId === mode.nodeId;
}
