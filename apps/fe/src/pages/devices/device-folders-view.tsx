// 设备管理页的主体：分组列表 + 节点分组的映射。
//
// 列表本身（拖拽、折叠、菜单、落点判定）在 `@vibeterm/panels/device-folders`，与业务解耦；
// 这里只负责把节点 id 翻译成「一个 node 分组」（把手塞进分组头），以及把布局变更
// 交给 `use-device-folders`（只打 self 节点），并把顶栏用的命令登记出去。
//
// 节点磁贴网格：mesh 下每个节点是网格里的一块磁贴，跨度 = min(设备数, 列数)，顺序不重排；
// 设备数由 `use-node-device-counts` 汇总后经 `nodeSpan` 交给列表。standalone（不显示节点头）
// 时那唯一的节点独占整行，就是原来那张整页宽的卡片网格。

import {
  type DeviceFolderDrop,
  type DeviceFolderNodeContext,
  DeviceFolderTree,
  type DeviceFolderTreeHandle,
  type NodeTileSize,
  applyDrop,
  implicitRootNodeIds,
  nodeTileSpan,
} from '@vibeterm/panels/device-folders';
import { useUIStore } from '@vibeterm/stores/react';
import { Button } from '@vibeterm/ui/button';
import { Reveal } from '@vibeterm/ui/motion';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NodeDeviceGroup, type NodeDeviceGroupEntry } from './node-device-group';
import { registerDevicesPageCommands } from './page-commands';
import { useDeviceFolders } from './use-device-folders';
import { useNodeDeviceCounts } from './use-node-device-counts';

/** 节点分组 → 列表的候选节点 id（顺序即根层隐式节点的顺序：self 在前，其余按名） */
export function nodeCandidates(groups: readonly NodeDeviceGroupEntry[]): string[] {
  return groups.map((group) => group.runtimeNodeId);
}

export interface DeviceFoldersViewProps {
  groups: NodeDeviceGroupEntry[];
  /** mesh 下才显示节点分组头；standalone / mesh 列表未到时根层直接就是 self 的卡片网格 */
  showNodeHeaders: boolean;
}

function FoldersLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="devices-folders-error"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
    >
      <span>{t('devices.folders.loadFailed')}</span>
      <Button type="button" size="xs" variant="outline" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

export function DeviceFoldersView({ groups, showNodeHeaders }: DeviceFoldersViewProps) {
  const folders = useDeviceFolders();
  const { countOf, report } = useNodeDeviceCounts(groups);
  const expanded = useUIStore((state) => state.deviceFolderExpanded);
  const setExpanded = useUIStore((state) => state.setDeviceFolderExpanded);
  const treeRef = useRef<DeviceFolderTreeHandle>(null);

  // 顶栏的按钮隔着一棵子树，只能靠模块级注册表把入口递上去
  const { resetLayout, layoutBusy } = folders;
  useEffect(
    () =>
      registerDevicesPageCommands({
        newFolder: () => treeRef.current?.startNewFolder(),
        resetLayout,
        layoutBusy,
      }),
    [resetLayout, layoutBusy]
  );

  const { layout, pending } = folders;
  const groupsById = useMemo(
    () => new Map(groups.map((group) => [group.runtimeNodeId, group])),
    [groups]
  );
  const candidates = useMemo(() => nodeCandidates(groups), [groups]);
  const implicit = useMemo(() => implicitRootNodeIds(layout, candidates), [layout, candidates]);

  const renderNode = useCallback(
    (nodeId: string, ctx: DeviceFolderNodeContext) => {
      const group = groupsById.get(nodeId);
      // mesh 列表里已经没有这台机器（被移除 / 撤销）：不渲染，也不动布局
      if (!group) return null;
      return (
        <NodeDeviceGroup
          node={group}
          showHeader={showNodeHeaders}
          dragControls={ctx.dragControls}
          tile={showNodeHeaders}
          onDeviceCount={report}
        />
      );
    },
    [groupsById, showNodeHeaders, report]
  );
  const nodeSpan = useCallback(
    (nodeId: string): NodeTileSize => (showNodeHeaders ? nodeTileSpan(countOf(nodeId)) : 'full'),
    [showNodeHeaders, countOf]
  );

  const nodeLabel = useCallback(
    (nodeId: string) => groupsById.get(nodeId)?.name ?? nodeId,
    [groupsById]
  );

  // standalone 只有一个节点且没有分组头：根层的它拖不到别处去；进了分组的仍要能拖回来
  const nodeDraggable = useCallback(
    (_nodeId: string, ctx: { folderId: string | null }) => showNodeHeaders || ctx.folderId !== null,
    [showNodeHeaders]
  );

  const { submitLayout } = folders;
  const handleDrop = useCallback(
    (drop: DeviceFolderDrop) => submitLayout(applyDrop(layout, drop, implicit)),
    [layout, implicit, submitLayout]
  );

  return (
    <Reveal data-testid="devices-folders-view" className="flex w-full min-w-0 flex-col gap-3">
      {folders.isError && <FoldersLoadError onRetry={folders.refetch} />}
      <DeviceFolderTree
        ref={treeRef}
        layout={layout}
        implicitRootNodeIds={implicit}
        renderNode={renderNode}
        nodeLabel={nodeLabel}
        nodeDraggable={nodeDraggable}
        nodeSpan={nodeSpan}
        expanded={expanded}
        onExpandedChange={setExpanded}
        onDrop={handleDrop}
        onCreateFolder={folders.createFolder}
        onRenameFolder={folders.renameFolder}
        onDeleteFolder={folders.deleteFolder}
        disabled={pending}
      />
      {/* 布局提交在飞时禁用拖拽，避免先发后到的旧顺序覆盖新顺序（与设备排序同一条规则） */}
      {pending && <span data-testid="devices-folders-pending" className="sr-only" />}
    </Reveal>
  );
}
