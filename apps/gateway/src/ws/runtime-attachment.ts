import type {
  DeviceSessionRuntime,
  DeviceSessionRuntimeListener,
} from '../tmux-client/device-session-runtime';
import type { DeviceConnectionRegistry } from './device-connection-registry';
import type { LegacyFeedBroadcaster } from './legacy-feed-broadcaster';
import type { SnapshotOverlayStore } from './snapshot-overlays';
import type { TerminalOutputBatcher } from './terminal-output-batcher';
import type { ThemeSettingsBroadcaster } from './theme-settings-broadcaster';
import type { DeviceConnectionEntry, WebSocketServerDeps } from './types';

export function attachRuntimeListener(
  feed: LegacyFeedBroadcaster,
  registry: DeviceConnectionRegistry,
  deviceId: string,
  runtime: DeviceSessionRuntime
): () => void {
  const listener: DeviceSessionRuntimeListener = {
    onEvent: (event) => {
      void feed.broadcastTmuxEvent(deviceId, event);
    },
    onTerminalOutput: (paneId, data) => {
      feed.broadcastTerminalOutput(deviceId, paneId, data);
    },
    onTerminalHistory: (paneId, data, alternateScreen, modes) => {
      feed.broadcastTerminalHistory(deviceId, paneId, data, alternateScreen, modes);
    },
    onClipboardWrite: (paneId, text) => {
      feed.broadcastClipboardWrite(deviceId, paneId, text);
    },
    onSnapshot: (payload) => {
      feed.broadcastStateSnapshot(deviceId, payload);
    },
    onMetadataPatch: (patch) => {
      feed.broadcastLegacyMetadataPatch(deviceId, patch, runtime.getCurrentSnapshot());
    },
    onMetadataRebaseRequired: () => {
      const snapshot = runtime.getCurrentSnapshot();
      if (snapshot) feed.broadcastStateSnapshot(deviceId, snapshot);
    },
    onError: (error) => {
      feed.broadcastError(deviceId, error);
    },
    onClose: () => {
      void registry.handleConnectionClose(deviceId);
    },
  };

  return runtime.subscribe(listener);
}

export function releaseDeviceConnection(input: {
  terminalOutputBatcher: TerminalOutputBatcher;
  registry: DeviceConnectionRegistry;
  theme: ThemeSettingsBroadcaster;
  overlays: SnapshotOverlayStore;
  deps: WebSocketServerDeps;
  deviceId: string;
  entry: DeviceConnectionEntry;
}): void {
  input.terminalOutputBatcher.discardDevice(input.deviceId);
  input.registry.clearSnapshotTimer(input.entry);
  input.registry.clearSnapshotPollTimer(input.entry);
  input.registry.clearReconnectTimer(input.entry);
  input.registry.clearIdleReleaseTimer(input.entry);
  input.entry.detachRuntime?.();
  input.entry.detachRuntime = null;
  input.theme.clearDevice(input.deviceId);
  input.overlays.deleteDeviceTreeOrder(input.deviceId);
  void input.deps.releaseRuntime(input.deviceId, input.entry.runtime);
}
