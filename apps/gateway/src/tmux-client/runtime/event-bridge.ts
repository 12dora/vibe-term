import { type StateSnapshotPayload, wsBorsh } from '@tmex/shared';

import type { LifecycleEventEmitter, TmuxConnectionOptions } from '../connection-types';
import type { DeviceSessionRuntimeListener } from '../device-session-runtime';
import type { TmuxSourceMetadataEvent } from '../events';
import type { MetadataProjection, MetadataProjectionOptions } from '../metadata-projection';
import type { PaneHistoryReader } from '../pane-history-reader';
import type { PaneIdentity, PaneRetention } from '../pane-retention';

export interface RuntimeEventBridgeHost {
  metadata: MetadataProjection;
  paneRetention: PaneRetention;
  getHistoryReader(): PaneHistoryReader;
  getLastSnapshot(): StateSnapshotPayload | null;
  setLastSnapshot(payload: StateSnapshotPayload): void;
  broadcast(action: (listener: DeviceSessionRuntimeListener) => void): void;
  handleUnexpectedClose(): void;
}

export class RuntimeEventBridge {
  constructor(private readonly host: RuntimeEventBridgeHost) {}

  metadataCallbacks(): Pick<MetadataProjectionOptions, 'onPatch' | 'onRebaseRequired'> {
    return {
      onPatch: (patch) => {
        const current = this.host.getLastSnapshot();
        if (current) {
          const diff = wsBorsh.sourceMetadataPatchToLegacyDiff(patch);
          this.host.setLastSnapshot(wsBorsh.applyLegacyStateSnapshotDiff(current, diff));
        }
        this.host.broadcast((listener) => listener.onMetadataPatch?.(patch));
      },
      onRebaseRequired: (snapshot) => {
        this.host.broadcast((listener) => listener.onMetadataRebaseRequired?.(snapshot));
      },
    };
  }

  connectionOptions(base: {
    deviceId: string;
    notifyEvent?: LifecycleEventEmitter;
  }): TmuxConnectionOptions {
    return {
      deviceId: base.deviceId,
      notifyEvent: base.notifyEvent,
      onEvent: (event) => {
        this.host.broadcast((listener) => listener.onEvent?.(event));
      },
      onTerminalOutput: (paneId, data) => {
        const paneEpoch = this.host.metadata.ensurePaneEpoch(paneId);
        if (paneEpoch) this.host.paneRetention.ingest(paneId, paneEpoch, data);
        this.host.broadcast((listener) => listener.onTerminalOutput?.(paneId, data));
      },
      onTerminalHistory: (paneId, data, alternateScreen, modes) => {
        this.host.broadcast((listener) =>
          listener.onTerminalHistory?.(paneId, data, alternateScreen, modes)
        );
      },
      onPromptMarker: (paneId, marker) => {
        this.host.broadcast((listener) => listener.onPromptMarker?.(paneId, marker));
      },
      onClipboardWrite: (paneId, text) => {
        this.host.broadcast((listener) => listener.onClipboardWrite?.(paneId, text));
      },
      onSourceReady: (serverEpoch) => {
        this.host.metadata.setServerEpoch(serverEpoch);
      },
      onSourceMetadata: (event: TmuxSourceMetadataEvent) => {
        this.host.metadata.applySourceEvent(event);
      },
      beginMetadataReconcile: () => this.host.metadata.revision,
      onSnapshot: (payload, baseRevision) => {
        const previousSnapshot = this.host.getLastSnapshot();
        const changed = !stateSnapshotsEqual(previousSnapshot, payload);
        this.host.setLastSnapshot(payload);
        this.host.metadata.reconcile(payload, baseRevision);
        const panes: PaneIdentity[] = [];
        for (const window of payload.session?.windows ?? []) {
          for (const pane of window.panes) {
            const paneEpoch = this.host.metadata.getPaneEpoch(pane.id);
            if (paneEpoch) panes.push({ paneId: pane.id, paneEpoch });
          }
        }
        this.host.paneRetention.reconcilePanes(panes);
        const currentPaneIds = new Set(panes.map((pane) => pane.paneId));
        const historyReader = this.host.getHistoryReader();
        for (const pane of panes) historyReader.invalidatePane(pane.paneId, pane.paneEpoch);
        for (const window of previousSnapshot?.session?.windows ?? []) {
          for (const pane of window.panes) {
            if (!currentPaneIds.has(pane.id)) historyReader.invalidatePane(pane.id);
          }
        }
        if (changed) this.host.broadcast((listener) => listener.onSnapshot?.(payload));
      },
      onError: (error) => {
        this.host.broadcast((listener) => listener.onError?.(error));
      },
      onClose: () => {
        this.host.handleUnexpectedClose();
      },
    };
  }
}

export function stateSnapshotsEqual(
  left: StateSnapshotPayload | null,
  right: StateSnapshotPayload
): boolean {
  if (!left || left.deviceId !== right.deviceId) return false;
  if (!left.session || !right.session) return left.session === right.session;
  if (
    left.session.id !== right.session.id ||
    left.session.name !== right.session.name ||
    left.session.windows.length !== right.session.windows.length
  ) {
    return false;
  }
  for (let windowIndex = 0; windowIndex < left.session.windows.length; windowIndex += 1) {
    const previousWindow = left.session.windows[windowIndex];
    const nextWindow = right.session.windows[windowIndex];
    if (
      !previousWindow ||
      !nextWindow ||
      previousWindow.id !== nextWindow.id ||
      previousWindow.name !== nextWindow.name ||
      previousWindow.customName !== nextWindow.customName ||
      previousWindow.index !== nextWindow.index ||
      previousWindow.active !== nextWindow.active ||
      previousWindow.layout !== nextWindow.layout ||
      previousWindow.panes.length !== nextWindow.panes.length
    ) {
      return false;
    }
    for (let paneIndex = 0; paneIndex < previousWindow.panes.length; paneIndex += 1) {
      const previousPane = previousWindow.panes[paneIndex];
      const nextPane = nextWindow.panes[paneIndex];
      if (
        !previousPane ||
        !nextPane ||
        previousPane.id !== nextPane.id ||
        previousPane.windowId !== nextPane.windowId ||
        previousPane.index !== nextPane.index ||
        previousPane.title !== nextPane.title ||
        previousPane.customName !== nextPane.customName ||
        previousPane.currentCommand !== nextPane.currentCommand ||
        previousPane.currentPath !== nextPane.currentPath ||
        previousPane.active !== nextPane.active ||
        previousPane.width !== nextPane.width ||
        previousPane.height !== nextPane.height ||
        previousPane.left !== nextPane.left ||
        previousPane.top !== nextPane.top
      ) {
        return false;
      }
    }
  }
  return true;
}
