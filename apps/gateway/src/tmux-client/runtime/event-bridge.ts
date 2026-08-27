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

const SESSION_COMPARE_KEYS = ['id', 'name'] as const;
const WINDOW_COMPARE_KEYS = ['id', 'name', 'customName', 'index', 'active', 'layout'] as const;
const PANE_COMPARE_KEYS = [
  'id',
  'windowId',
  'index',
  'title',
  'customName',
  'currentCommand',
  'currentPath',
  'active',
  'width',
  'height',
  'left',
  'top',
] as const;

function recordsEqualByKeys<T>(left: T, right: T, keys: readonly (keyof T)[]): boolean {
  return keys.every((key) => left[key] === right[key]);
}

function alignedEqual<T>(
  left: readonly T[],
  right: readonly T[],
  equal: (a: T, b: T) => boolean
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index];
    const next = right[index];
    if (!previous || !next || !equal(previous, next)) return false;
  }
  return true;
}

export function stateSnapshotsEqual(
  left: StateSnapshotPayload | null,
  right: StateSnapshotPayload
): boolean {
  if (!left || left.deviceId !== right.deviceId) return false;
  if (!left.session || !right.session) return left.session === right.session;
  if (!recordsEqualByKeys(left.session, right.session, SESSION_COMPARE_KEYS)) return false;
  return alignedEqual(left.session.windows, right.session.windows, (previousWindow, nextWindow) => {
    if (!recordsEqualByKeys(previousWindow, nextWindow, WINDOW_COMPARE_KEYS)) return false;
    return alignedEqual(previousWindow.panes, nextWindow.panes, (previousPane, nextPane) =>
      recordsEqualByKeys(previousPane, nextPane, PANE_COMPARE_KEYS)
    );
  });
}
