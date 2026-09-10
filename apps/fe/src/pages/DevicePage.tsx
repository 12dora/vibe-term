// 设备终端页薄壳：解析路由参数后渲染 @vibeterm/panels/device-console 的控制台组件。
// paneId 传路由段原值（React Router 已 decode 一次），decode 归一在包内做，此处不再 decode。

import { useGlobalDevice } from '@/components/global-device-provider';
import { DeviceNodeBadges } from '@/node/device-node-badges';
import { useRouteNodeId } from '@/node/node-runtime-boundary';
import {
  DeviceConsole,
  DeviceConsoleActions,
  DeviceConsolePageTitle,
} from '@vibeterm/panels/device-console';
import { useParams } from 'react-router';

interface DeviceRouteParams {
  deviceId?: string;
  windowId?: string;
  paneId?: string;
}

export default function DevicePage() {
  const { deviceId, windowId, paneId } = useParams();
  const { connection } = useGlobalDevice();
  return (
    <DeviceConsole
      deviceId={deviceId}
      windowId={windowId}
      paneId={paneId}
      connection={connection}
    />
  );
}

// PageWrapper 协议：具名导出 PageTitle/PageActions，接收路由 params 展开
export function PageTitle(params: DeviceRouteParams) {
  return <DeviceConsolePageTitle {...params} />;
}

// 头部动作区：先放链路徽标（浏览器 → node → tmux 的合计延迟），再放控制台动作。
// 徽标要按设备取宿主那一跳的读数，因此把路由里的 deviceId 递下去。
export function PageActions(params: DeviceRouteParams) {
  const nodeId = useRouteNodeId();
  return (
    <>
      <DeviceNodeBadges nodeId={nodeId} deviceId={params.deviceId} />
      <DeviceConsoleActions {...params} />
    </>
  );
}
