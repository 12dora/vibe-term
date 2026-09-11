// 首屏意图（canonical-screen-intent-v1）的服务端解析：
// 客户端在 metadata 未到达时只给得出 (deviceId, windowId?, paneId?)，
// 网关 attach 之后按自己的 metadata 投影把它落成一个具体 pane。

import { wsBorsh } from '@vibeterm/shared';

import type { CanonicalFeedRuntime } from './types';

export interface CanonicalScreenIntentCommand {
  requestId: Uint8Array;
  deviceId: string;
  windowId: string | null;
  paneId: string | null;
  byteLimit: number;
}

function isActive(record: wsBorsh.SourceMetadataRecord): boolean {
  return record.fields.some(
    (field) =>
      field.field === wsBorsh.SOURCE_FIELD_ACTIVE &&
      'Bool' in field.value &&
      field.value.Bool === true
  );
}

/**
 * pane 未指定时的回落：给定 window 取它的活动 pane，未给定 window 取设备的活动窗口。
 * 活动标记缺失（老 tmux 快照）时退到记录顺序里的第一个，宁可给一屏也不空手而归。
 */
export function resolveIntentPaneId(
  runtime: CanonicalFeedRuntime,
  windowId: string | null
): string | null {
  const records = runtime.getMetadataSnapshot().records;
  const windows = records.filter(
    (record) => record.key.entityKind === wsBorsh.SOURCE_ENTITY_WINDOW
  );
  const targetWindow = windowId
    ? (windows.find((record) => record.key.nativeId === windowId) ?? null)
    : (windows.find(isActive) ?? windows[0] ?? null);
  if (!targetWindow) return null;
  const panes = records.filter(
    (record) =>
      record.key.entityKind === wsBorsh.SOURCE_ENTITY_PANE &&
      record.parent?.entityKind === wsBorsh.SOURCE_ENTITY_WINDOW &&
      record.parent.nativeId === targetWindow.key.nativeId
  );
  const pane = panes.find(isActive) ?? panes[0] ?? null;
  return pane ? pane.key.nativeId : null;
}
