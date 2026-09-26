// 直连切回 primary（含直连异常关闭）后的补齐与提示。

import type { NotificationSink } from '@vibeterm/notifications';
import type { AppRuntime } from '@vibeterm/stores';
import type { GatewayConnection } from '@vibeterm/ws-client';
import i18n from 'i18next';

/** 该 device 下当前**挂载着终端实例**的 pane（注册表里有 sink 即挂载中）。 */
function mountedPaneIds(
  connection: GatewayConnection,
  runtime: AppRuntime,
  deviceId: string
): string[] {
  const tmux = runtime.stores.tmux.getState();
  const ids = new Set<string>();
  for (const window of tmux.snapshots[deviceId]?.session?.windows ?? []) {
    for (const pane of window.panes) {
      if (connection.paneSinks.hasPaneSink(deviceId, pane.id)) ids.add(pane.id);
    }
  }
  const selected = tmux.selectedPanes[deviceId];
  if (selected && connection.paneSinks.hasPaneSink(deviceId, selected.paneId)) {
    ids.add(selected.paneId);
  }
  return [...ids];
}

/** 直连断开提示的文案 key（locale 里有正式条目，不再靠 `defaultValue` 兜底）。 */
const DIRECT_FALLBACK_KEY = 'device.directFallbackToast';

/** runtime 还没建好时它自己的 `t` 也没有，退到宿主的全局 i18n 实例。 */
function directFallbackText(runtime: AppRuntime | null): string {
  return runtime?.t(DIRECT_FALLBACK_KEY) || i18n.t(DIRECT_FALLBACK_KEY) || DIRECT_FALLBACK_KEY;
}

/**
 * 切回 primary（含直连异常关闭）后的补齐：
 * 1. 重发该 device 的整份 pane 订阅——`mountPane()` 拿到的释放函数**立刻调用**，
 *    引用计数一加一减回到原值，但两次都会以新 generation 重下发当前订阅集合；
 *    订阅面在 `@vibeterm/stores`，没有对外暴露「只重发一次」的入口。
 * 2. 提示用户：浏览器→node 方向的最近输入可能没送到（这一方向没有补齐机制）。
 *
 * canonical feed 由带 cursor 的重订阅精确补流，只有服务端明确返回 gap 时才重取整屏，
 * 因此这里不主动请求首屏。runtime 还没建好时只提示。
 */
export function resumeAfterDirectFallback(
  connection: GatewayConnection,
  runtime: AppRuntime | null,
  sink: NotificationSink
): void {
  if (runtime) {
    const tmux = runtime.stores.tmux.getState();
    for (const deviceId of tmux.connectedDevices) {
      const first = mountedPaneIds(connection, runtime, deviceId)[0];
      if (first === undefined) continue;
      tmux.mountPane(deviceId, first)();
    }
  }
  sink.warning(directFallbackText(runtime));
}
