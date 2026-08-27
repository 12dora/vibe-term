// pane 绑定解析：把 (deviceId, paneId) 映射到快照中的 window/pane 与展示标签。

import type { Device, StateSnapshotPayload, TmuxSession } from '@tmex/shared';
import { buildTerminalLabel } from '@tmex/stores';

export interface BindingInfo {
  label: string;
  state: 'valid' | 'invalid' | 'unknown';
  windowId: string | null;
}

export type SnapshotMap = Record<string, StateSnapshotPayload | undefined>;

type SnapshotWindow = TmuxSession['windows'][number];
type SnapshotPane = SnapshotWindow['panes'][number];

function findPane(
  snapshots: SnapshotMap,
  deviceId: string,
  paneId: string
): { window: SnapshotWindow; pane: SnapshotPane } | null {
  for (const window of snapshots[deviceId]?.session?.windows ?? []) {
    const pane = window.panes.find((candidate) => candidate.id === paneId);
    if (pane) return { window, pane };
  }
  return null;
}

export function findPaneTitle(
  snapshots: SnapshotMap,
  deviceId: string | null,
  paneId: string | null
): string | null {
  if (!deviceId || !paneId) return null;
  return findPane(snapshots, deviceId, paneId)?.pane.title ?? null;
}

export function resolveBinding(
  binding: { deviceId: string | null; paneId: string | null },
  snapshots: SnapshotMap,
  devices: Device[] | undefined
): BindingInfo | null {
  if (!binding.deviceId || !binding.paneId) {
    return null;
  }
  const deviceName = devices?.find((device) => device.id === binding.deviceId)?.name ?? null;
  const fallbackLabel = `${binding.paneId}@${deviceName ?? '?'}`;
  if (!snapshots[binding.deviceId]?.session) {
    return { label: fallbackLabel, state: 'unknown', windowId: null };
  }
  const found = findPane(snapshots, binding.deviceId, binding.paneId);
  if (!found) {
    return { label: fallbackLabel, state: 'invalid', windowId: null };
  }
  return {
    label: buildTerminalLabel({
      paneCustomName: found.pane.customName,
      paneTitle: found.pane.title,
      windowName: found.window.name,
      windowCustomName: found.window.customName,
      deviceName,
    }),
    state: 'valid',
    windowId: found.window.id,
  };
}
