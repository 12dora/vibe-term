// 设备管理页的主体：文件夹树 + 节点分组 / 单卡的映射。
//
// 树本身（拖拽、折叠、菜单、落点判定）在 `@tmex/panels/device-folders`，与业务解耦；
// 这里只负责把条目翻译成「一个 node 分组」或「一台被单独放置的设备」，以及把布局变更
// 交给 `use-device-folders`（只打 self 节点）。

import {
  type DeviceFolderDrop,
  DeviceFolderItemShell,
  DeviceFolderTree,
  type DeviceFolderTreeHandle,
  applyDrop,
  implicitRootItems,
  placedDeviceIds,
} from '@tmex/panels/device-folders';
import type { DeviceManagementPanelProps } from '@tmex/panels/device-management';
import type { Device, DeviceFolderItemRef } from '@tmex/shared';
import { deviceFolderItemKey } from '@tmex/shared';
import { useUIStore } from '@tmex/stores/react';
import { Button } from '@tmex/ui/button';
import { Reveal } from '@tmex/ui/motion';
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { deviceDisplayName, rememberDeviceName } from './device-name-cache';
import { registerNewFolderRequest } from './new-folder-request';
import { NodeDeviceGroup, type NodeDeviceGroupEntry } from './node-device-group';
import { PlacedDevice } from './placed-device';
import { useDeviceFolders } from './use-device-folders';

/** 节点分组 → 树的候选条目（顺序即根层隐式条目的顺序：self 在前，其余按名） */
export function nodeItemCandidates(groups: readonly NodeDeviceGroupEntry[]): DeviceFolderItemRef[] {
  return groups.map((group) => ({
    kind: 'node' as const,
    nodeId: group.runtimeNodeId,
    deviceId: null,
  }));
}

function makeRenderCard(
  runtimeNodeId: string,
  dragDisabled: boolean
): NonNullable<DeviceManagementPanelProps['renderCard']> {
  return (card: ReactNode, device: Device) => {
    rememberDeviceName(runtimeNodeId, device.id, device.name);
    return (
      <DeviceFolderItemShell
        key={device.id}
        itemKey={deviceFolderItemKey({
          kind: 'device',
          nodeId: runtimeNodeId,
          deviceId: device.id,
        })}
        mode="draggable"
        disabled={dragDisabled}
      >
        {card}
      </DeviceFolderItemShell>
    );
  };
}

export interface DeviceFoldersViewProps {
  groups: NodeDeviceGroupEntry[];
  /** mesh 下才显示节点分组头；standalone / mesh 列表未到时根层直接就是 self 的卡片网格 */
  showNodeHeaders: boolean;
}

export function DeviceFoldersView({ groups, showNodeHeaders }: DeviceFoldersViewProps) {
  const { t } = useTranslation();
  const folders = useDeviceFolders();
  const expanded = useUIStore((state) => state.deviceFolderExpanded);
  const setExpanded = useUIStore((state) => state.setDeviceFolderExpanded);
  const treeRef = useRef<DeviceFolderTreeHandle>(null);

  // 顶栏的「新建文件夹」按钮隔着一棵子树，只能靠模块级注册表把入口递上去
  useEffect(() => registerNewFolderRequest(() => treeRef.current?.startNewFolder(null)), []);

  const { layout, pending } = folders;
  const groupsById = useMemo(
    () => new Map(groups.map((group) => [group.runtimeNodeId, group])),
    [groups]
  );
  const candidates = useMemo(() => nodeItemCandidates(groups), [groups]);
  const implicit = useMemo(() => implicitRootItems(layout, candidates), [layout, candidates]);
  const excludedByNode = useMemo(() => {
    const map = new Map<string, ReadonlySet<string>>();
    for (const group of groups) {
      map.set(group.runtimeNodeId, placedDeviceIds(layout, group.runtimeNodeId));
    }
    return map;
  }, [groups, layout]);
  const renderCardByNode = useMemo(() => {
    const map = new Map<string, NonNullable<DeviceManagementPanelProps['renderCard']>>();
    for (const group of groups) {
      map.set(group.runtimeNodeId, makeRenderCard(group.runtimeNodeId, pending));
    }
    return map;
  }, [groups, pending]);

  const renderItem = useCallback(
    (item: DeviceFolderItemRef) => {
      const group = groupsById.get(item.nodeId) ?? null;
      if (item.kind === 'node') {
        // mesh 列表里已经没有这台机器（被移除 / 撤销）：不渲染，也不动布局
        if (!group) return null;
        return (
          <NodeDeviceGroup
            node={group}
            showHeader={showNodeHeaders}
            excludeDeviceIds={excludedByNode.get(group.runtimeNodeId)}
            renderCard={renderCardByNode.get(group.runtimeNodeId)}
          />
        );
      }
      return <PlacedDevice item={item} node={group} />;
    },
    [groupsById, excludedByNode, renderCardByNode, showNodeHeaders]
  );

  const itemLabel = useCallback(
    (item: DeviceFolderItemRef) => {
      if (item.kind === 'node') return groupsById.get(item.nodeId)?.name ?? item.nodeId;
      return deviceDisplayName(item.nodeId, item.deviceId ?? '');
    },
    [groupsById]
  );

  const itemDraggable = useCallback(
    (item: DeviceFolderItemRef, ctx: { folderId: string | null }) =>
      showNodeHeaders || item.kind !== 'node' || ctx.folderId !== null,
    [showNodeHeaders]
  );

  const { submitLayout } = folders;
  const handleDrop = useCallback(
    (drop: DeviceFolderDrop) => submitLayout(applyDrop(layout, drop, implicit)),
    [layout, implicit, submitLayout]
  );

  return (
    <Reveal
      data-testid="devices-folders-view"
      className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:gap-4 sm:p-5"
    >
      {folders.isError && (
        <div
          data-testid="devices-folders-error"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        >
          <span>{t('devices.folders.loadFailed')}</span>
          <Button type="button" size="xs" variant="outline" onClick={folders.refetch}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      <DeviceFolderTree
        ref={treeRef}
        layout={layout}
        implicitRootItems={implicit}
        renderItem={renderItem}
        itemLabel={itemLabel}
        itemDraggable={itemDraggable}
        expanded={expanded}
        onExpandedChange={setExpanded}
        onDrop={handleDrop}
        onCreateFolder={folders.createFolder}
        onRenameFolder={folders.renameFolder}
        onDeleteFolder={folders.deleteFolder}
        onMoveItemToRoot={folders.moveItemToRoot}
        disabled={pending}
      />
      {/* 布局提交在飞时禁用拖拽，避免先发后到的旧顺序覆盖新顺序（与设备树重排同一条规则） */}
      {pending && <span data-testid="devices-folders-pending" className="sr-only" />}
    </Reveal>
  );
}
