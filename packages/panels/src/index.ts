// 业务面板包根出口：轻量、宿主外壳直接常驻挂载的两个状态指示组件。
// 重面板（agent/files/settings/…）走各自子路径出口以保持代码分割。

export { ConnectionIndicator } from './connection-indicator';
export { DeviceStatusBadge } from './device-status-badge';
