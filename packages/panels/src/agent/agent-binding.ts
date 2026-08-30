// pane 绑定解析：把 (deviceId, paneId) 映射到快照中的 window/pane 与展示标签。

import type { Device, StateSnapshotPayload, TmuxSession } from '@tmex/shared';
import { buildTerminalLabel } from '@tmex/stores';

export interface BindingInfo {
  label: string;
  state: 'valid' | 'invalid' | 'unknown';
  windowId: string | null;
}

export type SnapshotMap = Record<string, StateSnapshotPayload | undefined>;

/** 绑定来源：pane 及其所属设备，取自活动会话或草稿 */
export interface BindingSource {
  deviceId: string | null;
  paneId: string | null;
}

type SnapshotWindow = TmuxSession['windows'][number];
type SnapshotPane = SnapshotWindow['panes'][number];

/**
 * 取单台设备的快照。作为 store selector 使用时返回值只随该设备变化，
 * 无关设备的快照更新虽会替换整张 map，窄订阅的结果引用不变，不触发重渲染。
 */
export function deviceSnapshot(
  snapshots: SnapshotMap,
  deviceId: string | null
): StateSnapshotPayload | undefined {
  return deviceId ? snapshots[deviceId] : undefined;
}

/** 有活动会话取会话，否则取草稿（草稿态 chip 显示的是将要绑定的 pane） */
export function bindingSource(
  activeSession: BindingSource | undefined,
  draft: BindingSource | null
): BindingSource | null {
  if (activeSession) return { deviceId: activeSession.deviceId, paneId: activeSession.paneId };
  return draft ? { deviceId: draft.deviceId, paneId: draft.paneId } : null;
}

function findPane(
  snapshot: StateSnapshotPayload | undefined,
  paneId: string
): { window: SnapshotWindow; pane: SnapshotPane } | null {
  for (const window of snapshot?.session?.windows ?? []) {
    const pane = window.panes.find((candidate) => candidate.id === paneId);
    if (pane) return { window, pane };
  }
  return null;
}

export function findPaneTitle(
  snapshot: StateSnapshotPayload | undefined,
  paneId: string | null
): string | null {
  if (!paneId) return null;
  return findPane(snapshot, paneId)?.pane.title ?? null;
}

export function resolveBinding(
  binding: BindingSource,
  snapshot: StateSnapshotPayload | undefined,
  devices: Device[] | undefined
): BindingInfo | null {
  if (!binding.deviceId || !binding.paneId) {
    return null;
  }
  const deviceName = devices?.find((device) => device.id === binding.deviceId)?.name ?? null;
  const fallbackLabel = `${binding.paneId}@${deviceName ?? '?'}`;
  if (!snapshot?.session) {
    return { label: fallbackLabel, state: 'unknown', windowId: null };
  }
  const found = findPane(snapshot, binding.paneId);
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
