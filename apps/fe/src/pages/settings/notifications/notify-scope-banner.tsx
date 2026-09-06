// 「通知」标签顶部的范围提示。
//
// 通知通道（webhook / Telegram / 微信 / 浏览器）一律属于**被编辑的那台机器**：经 `/n/<id>`
// 打开设置页时改的是那台远端节点的通道，只在本机配好收不到别人的事件。远程访问标签早有
// 同类提示，这里补上通知这一块。standalone 没有第二台机器，不提示。

import { useSharedAuthMode } from '@/node/mesh-nodes';
import { resolveMeshNodeName } from '@/node/node-names';
import { useRouteNodeId } from '@/node/node-runtime-boundary';
import { isSelfNode } from '@vibeterm/api-client';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';

/** 节点展示名；节点目录还没拉到就退回编号前缀。 */
export function nodeDisplayName(nodeId: string, resolved: string | null): string {
  return resolved ?? nodeId.slice(0, 8);
}

export function NotifyScopeBanner() {
  const { t } = useTranslation();
  const routeNodeId = useRouteNodeId();
  const { meshEnabled } = useSharedAuthMode();
  const remote = !isSelfNode(routeNodeId);
  const name = nodeDisplayName(routeNodeId, resolveMeshNodeName(routeNodeId));

  if (!remote && !meshEnabled) return null;

  return (
    <Notice tone="info" testId="settings-notify-scope-banner">
      {remote
        ? t('settings.notifications.scope.remote', { name })
        : t('settings.notifications.scope.self')}
    </Notice>
  );
}
