// canonical v1.1：元数据记录（SourceMetadataSnapshot / SourceMetadataPatch）折叠成 tmux 会话树。
//
// 这里只有纯计算与进程内状态：不碰 window / document / localStorage，也不依赖 React / zustand /
// i18next，浏览器 store 与 Node CLI 共用同一份实现，两边的树不会各自漂移。
// 缓存副作用（pane 订阅、cursor、重订阅）留在 `canonical-metadata-identity.ts`，它复用本模块的折叠。

import type { StateSnapshotPayload, TmuxPane, TmuxSession, TmuxWindow } from '@vibeterm/shared';
import { wsBorsh } from '@vibeterm/shared';
import { CanonicalMetadataAssemblies } from './canonical-metadata-assemblies';
import {
  type DeviceMetadataState,
  type MetadataPatchEvent,
  type MetadataSnapshotEvent,
  bytesEqual,
  copyBytes,
} from './canonical-state-helpers';

export type { DeviceMetadataState } from './canonical-state-helpers';

export type MetadataIdentityAction =
  | { kind: 'server-epoch-changed'; deviceId: string }
  | { kind: 'pane-removed'; deviceId: string; paneId: string }
  | { kind: 'pane-epoch-changed'; deviceId: string; paneId: string }
  | { kind: 'pane-epoch-unset'; deviceId: string; paneId: string };

// ---------------------------------------------------------------- 纯折叠

export function paneEpochsFromRecords(
  records: readonly wsBorsh.SourceMetadataRecord[]
): Map<string, Uint8Array> {
  const epochs = new Map<string, Uint8Array>();
  for (const record of records) {
    if (record.key.entityKind !== wsBorsh.SOURCE_ENTITY_PANE) continue;
    const field = record.fields.find((item) => item.field === wsBorsh.SOURCE_FIELD_PANE_EPOCH);
    if (field && 'Bytes16' in field.value) {
      epochs.set(record.key.nativeId, copyBytes(field.value.Bytes16));
    }
  }
  return epochs;
}

export function groupRecordsByDevice(
  records: readonly wsBorsh.SourceMetadataRecord[]
): Map<string, wsBorsh.SourceMetadataRecord[]> {
  const byDevice = new Map<string, wsBorsh.SourceMetadataRecord[]>();
  for (const record of records) {
    const group = byDevice.get(record.key.deviceId) ?? [];
    group.push(record);
    byDevice.set(record.key.deviceId, group);
  }
  return byDevice;
}

export function assembleDeviceMetadata(
  deviceId: string,
  metadataEpoch: Uint8Array,
  revision: bigint,
  deviceRecords: readonly wsBorsh.SourceMetadataRecord[]
): DeviceMetadataState | null {
  const serverEpoch = deviceRecords[0]?.key.serverEpoch;
  if (!serverEpoch) return null;
  const projection = wsBorsh.sourceMetadataPatchToLegacyDiff({
    metadataEpoch,
    fromRevision: 0n,
    throughRevision: revision,
    upserts: [...deviceRecords],
    removals: [],
  });
  const treeOrder = wsBorsh.createCanonicalTreeOrder(deviceRecords);
  const projected = wsBorsh.applyLegacyStateSnapshotDiff({ deviceId, session: null }, projection);
  return {
    metadataEpoch: copyBytes(metadataEpoch),
    revision,
    serverEpoch: copyBytes(serverEpoch),
    paneEpochs: paneEpochsFromRecords(deviceRecords),
    treeOrder,
    baseSnapshot: projected,
    snapshot: wsBorsh.sortSnapshotByCanonicalTreeOrder(projected, treeOrder),
  };
}

/**
 * 增量折叠：`patch` 必须只含该设备的记录（用 `patchRecordsForDevice` 过滤）。
 * diff 落在未排序底稿上，展示顺序每次由底稿重算——顺序被 Unset 时才能退回 tmux index 顺序。
 */
export function applyDeviceTreePatch(state: DeviceMetadataState, patch: MetadataPatchEvent): void {
  const projection = wsBorsh.sourceMetadataPatchToLegacyDiff(patch);
  wsBorsh.applyCanonicalTreeOrderPatch(state.treeOrder, patch.upserts, patch.removals);
  state.revision = patch.throughRevision;
  state.baseSnapshot = wsBorsh.applyLegacyStateSnapshotDiff(state.baseSnapshot, projection);
  state.snapshot = wsBorsh.sortSnapshotByCanonicalTreeOrder(state.baseSnapshot, state.treeOrder);
}

export function applyMetadataIdentity(
  state: DeviceMetadataState,
  upserts: readonly wsBorsh.SourceMetadataRecord[],
  removals: readonly wsBorsh.SourceEntityKey[]
): MetadataIdentityAction[] {
  const actions: MetadataIdentityAction[] = [];
  const epochChanged = applyServerEpochChange(state, upserts, removals);
  if (epochChanged) actions.push(epochChanged);
  for (const key of removals) {
    const action = applyPaneRemoval(state, key);
    if (action) actions.push(action);
  }
  for (const record of upserts) {
    const action = applyPaneUpsert(state, record);
    if (action) actions.push(action);
  }
  return actions;
}

export function deviceIdsFromMetadataPatch(event: MetadataPatchEvent): Set<string> {
  const deviceIds = new Set<string>();
  for (const record of event.upserts) deviceIds.add(record.key.deviceId);
  for (const key of event.removals) deviceIds.add(key.deviceId);
  return deviceIds;
}

export function metadataPatchMatchesState(
  state: DeviceMetadataState | undefined,
  event: MetadataPatchEvent
): state is DeviceMetadataState {
  return Boolean(
    state &&
      bytesEqual(state.metadataEpoch, event.metadataEpoch) &&
      state.revision === event.fromRevision
  );
}

export function patchRecordsForDevice(
  event: MetadataPatchEvent,
  deviceId: string
): {
  upserts: wsBorsh.SourceMetadataRecord[];
  removals: wsBorsh.SourceEntityKey[];
} {
  return {
    upserts: event.upserts.filter((record) => record.key.deviceId === deviceId),
    removals: event.removals.filter((key) => key.deviceId === deviceId),
  };
}

function applyServerEpochChange(
  state: DeviceMetadataState,
  upserts: readonly wsBorsh.SourceMetadataRecord[],
  removals: readonly wsBorsh.SourceEntityKey[]
): MetadataIdentityAction | null {
  const nextServerEpoch = upserts[0]?.key.serverEpoch ?? removals[0]?.serverEpoch;
  if (!nextServerEpoch || bytesEqual(state.serverEpoch, nextServerEpoch)) return null;
  state.serverEpoch = copyBytes(nextServerEpoch);
  state.paneEpochs.clear();
  return {
    kind: 'server-epoch-changed',
    deviceId: upserts[0]?.key.deviceId ?? removals[0]?.deviceId ?? '',
  };
}

function applyPaneRemoval(
  state: DeviceMetadataState,
  key: wsBorsh.SourceEntityKey
): MetadataIdentityAction | null {
  if (key.entityKind !== wsBorsh.SOURCE_ENTITY_PANE) return null;
  state.paneEpochs.delete(key.nativeId);
  return { kind: 'pane-removed', deviceId: key.deviceId, paneId: key.nativeId };
}

function applyPaneUpsert(
  state: DeviceMetadataState,
  record: wsBorsh.SourceMetadataRecord
): MetadataIdentityAction | null {
  if (record.key.entityKind !== wsBorsh.SOURCE_ENTITY_PANE) return null;
  const field = record.fields.find((item) => item.field === wsBorsh.SOURCE_FIELD_PANE_EPOCH);
  if (!field) return null;
  const deviceId = record.key.deviceId;
  const paneId = record.key.nativeId;
  if ('Bytes16' in field.value) {
    const previous = state.paneEpochs.get(paneId);
    const changed = Boolean(previous && !bytesEqual(previous, field.value.Bytes16));
    state.paneEpochs.set(paneId, copyBytes(field.value.Bytes16));
    return changed ? { kind: 'pane-epoch-changed', deviceId, paneId } : null;
  }
  if ('Unset' in field.value) {
    state.paneEpochs.delete(paneId);
    return { kind: 'pane-epoch-unset', deviceId, paneId };
  }
  return null;
}

// ---------------------------------------------------------------- 有状态外壳

export interface CanonicalTreeOptions {
  /**
   * 折叠断链时触发：快照分片超时 / 越限，或 patch 的 metadata epoch、revision 对不上。
   * 本模块不会自作主张丢掉已有的树，调用方收到后应重新订阅拉一次全量快照。
   */
  onGap?(deviceId?: string): void;
  maxBufferedBytes?: number;
  assemblyTimeoutMs?: number;
}

export interface CanonicalTreeDevice {
  deviceId: string;
  session: TmuxSession | null;
  serverEpoch: Uint8Array;
  revision: bigint;
  /** paneId → pane epoch；订阅 pane 数据流时要带上，epoch 变了说明 pane 已被重建 */
  paneEpochs: ReadonlyMap<string, Uint8Array>;
}

export interface CanonicalTree {
  /** 分片未收齐时返回空数组；收齐即返回本次重建了树的 deviceId */
  applySnapshot(event: MetadataSnapshotEvent): string[];
  /** 返回本次被增量更新的 deviceId；对不上的设备只报 gap，不改树 */
  applyPatch(event: MetadataPatchEvent): string[];
  /** 不传 deviceId 即清空全部设备与半截分片 */
  reset(deviceId?: string): void;
  get(): TmuxSession[];
  session(deviceId: string): TmuxSession | null;
  snapshot(deviceId: string): StateSnapshotPayload | null;
  device(deviceId: string): CanonicalTreeDevice | null;
  deviceIds(): string[];
  /** 释放分片超时定时器；不再使用该实例时必须调用，否则 Node 进程不会退出 */
  dispose(): void;
}

export function createCanonicalTree(options: CanonicalTreeOptions = {}): CanonicalTree {
  const devices = new Map<string, DeviceMetadataState>();
  const assemblies = new CanonicalMetadataAssemblies({
    maxBufferedBytes: options.maxBufferedBytes,
    timeoutMs: options.assemblyTimeoutMs,
    onGap: () => options.onGap?.(),
  });

  const patchDevice = (event: MetadataPatchEvent, deviceId: string): boolean => {
    const state = devices.get(deviceId);
    if (!metadataPatchMatchesState(state, event)) {
      options.onGap?.(deviceId);
      return false;
    }
    const { upserts, removals } = patchRecordsForDevice(event, deviceId);
    applyMetadataIdentity(state, upserts, removals);
    applyDeviceTreePatch(state, { ...event, upserts, removals });
    return true;
  };

  return {
    applySnapshot(event) {
      const completed = assemblies.accept(event);
      if (!completed) return [];
      const changed: string[] = [];
      for (const [deviceId, records] of groupRecordsByDevice(completed.records)) {
        const assembled = assembleDeviceMetadata(
          deviceId,
          completed.metadataEpoch,
          completed.revision,
          records
        );
        if (!assembled) continue;
        devices.set(deviceId, assembled);
        changed.push(deviceId);
      }
      return changed;
    },

    applyPatch(event) {
      if (event.throughRevision < event.fromRevision) {
        options.onGap?.();
        return [];
      }
      const changed: string[] = [];
      for (const deviceId of deviceIdsFromMetadataPatch(event)) {
        if (patchDevice(event, deviceId)) changed.push(deviceId);
      }
      return changed;
    },

    reset(deviceId) {
      if (deviceId === undefined) {
        devices.clear();
        assemblies.clear();
        return;
      }
      devices.delete(deviceId);
    },

    get() {
      const sessions: TmuxSession[] = [];
      for (const deviceId of [...devices.keys()].sort()) {
        const session = devices.get(deviceId)?.snapshot.session;
        if (session) sessions.push(session);
      }
      return sessions;
    },

    session(deviceId) {
      return devices.get(deviceId)?.snapshot.session ?? null;
    },

    snapshot(deviceId) {
      return devices.get(deviceId)?.snapshot ?? null;
    },

    device(deviceId) {
      const state = devices.get(deviceId);
      if (!state) return null;
      return {
        deviceId,
        session: state.snapshot.session,
        serverEpoch: state.serverEpoch,
        revision: state.revision,
        paneEpochs: state.paneEpochs,
      };
    },

    deviceIds() {
      return [...devices.keys()].sort();
    },

    dispose() {
      assemblies.clear();
    },
  };
}

// ---------------------------------------------------------------- 纯定位

export function activeWindow(session: TmuxSession | null): TmuxWindow | null {
  if (!session) return null;
  return session.windows.find((window) => window.active) ?? session.windows[0] ?? null;
}

export function activePane(window: TmuxWindow | null): TmuxPane | null {
  if (!window) return null;
  return window.panes.find((pane) => pane.active) ?? window.panes[0] ?? null;
}

export function findWindowById(session: TmuxSession | null, windowId: string): TmuxWindow | null {
  return session?.windows.find((window) => window.id === windowId) ?? null;
}

export function findWindowByIndex(session: TmuxSession | null, index: number): TmuxWindow | null {
  return session?.windows.find((window) => window.index === index) ?? null;
}

/** 自定义名优先于 tmux window name，两者都要求完全相等 */
export function findWindowByName(session: TmuxSession | null, name: string): TmuxWindow | null {
  const windows = session?.windows ?? [];
  return (
    windows.find((window) => window.customName === name) ??
    windows.find((window) => window.name === name) ??
    null
  );
}

export function findPaneById(session: TmuxSession | null, paneId: string): TmuxPane | null {
  for (const window of session?.windows ?? []) {
    const pane = window.panes.find((item) => item.id === paneId);
    if (pane) return pane;
  }
  return null;
}

export function findPaneByIndex(window: TmuxWindow | null, index: number): TmuxPane | null {
  return window?.panes.find((pane) => pane.index === index) ?? null;
}

/** 自定义名优先于 OSC 标题，两者都要求完全相等 */
export function findPaneByName(window: TmuxWindow | null, name: string): TmuxPane | null {
  const panes = window?.panes ?? [];
  return (
    panes.find((pane) => pane.customName === name) ??
    panes.find((pane) => pane.title === name) ??
    null
  );
}

/** `@3` 按 tmux id，纯数字按 index，其余按名字 */
export function resolveWindow(session: TmuxSession | null, ref: string): TmuxWindow | null {
  if (ref.startsWith('@')) return findWindowById(session, ref);
  const index = parseIndex(ref);
  if (index !== null) return findWindowByIndex(session, index);
  return findWindowByName(session, ref);
}

/** `%7` 按 tmux id，`2.1` 按「窗口引用.pane index」，纯数字按活动窗口内 index，其余按名字 */
export function resolvePane(session: TmuxSession | null, ref: string): TmuxPane | null {
  if (ref.startsWith('%')) return findPaneById(session, ref);
  const dot = ref.lastIndexOf('.');
  if (dot > 0) {
    const index = parseIndex(ref.slice(dot + 1));
    const window = resolveWindow(session, ref.slice(0, dot));
    return index === null ? null : findPaneByIndex(window, index);
  }
  const index = parseIndex(ref);
  if (index !== null) return findPaneByIndex(activeWindow(session), index);
  return findPaneByNameInSession(session, ref);
}

function findPaneByNameInSession(session: TmuxSession | null, name: string): TmuxPane | null {
  const focused = activeWindow(session);
  const inFocused = findPaneByName(focused, name);
  if (inFocused) return inFocused;
  for (const window of session?.windows ?? []) {
    if (window === focused) continue;
    const pane = findPaneByName(window, name);
    if (pane) return pane;
  }
  return null;
}

function parseIndex(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}
