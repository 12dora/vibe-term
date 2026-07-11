// 设备终端页薄壳：解析路由参数后渲染 @tmex/panels/device-console 的控制台组件。
// paneId 传路由段原值（React Router 已 decode 一次），decode 归一在包内做，此处不再 decode。

import {
  DeviceConsole,
  DeviceConsoleActions,
  DeviceConsolePageTitle,
} from '@tmex/panels/device-console';
import { useParams } from 'react-router';

interface DeviceRouteParams {
  deviceId?: string;
  windowId?: string;
  paneId?: string;
}

export default function DevicePage() {
  const { deviceId, windowId, paneId } = useParams();
  return <DeviceConsole deviceId={deviceId} windowId={windowId} paneId={paneId} />;
}

// PageWrapper 协议：具名导出 PageTitle/PageActions，接收路由 params 展开
export function PageTitle(params: DeviceRouteParams) {
  return <DeviceConsolePageTitle {...params} />;
}

export function PageActions(params: DeviceRouteParams) {
  return <DeviceConsoleActions {...params} />;
}
