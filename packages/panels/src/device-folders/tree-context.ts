// `DeviceFolderTree` 与它的子组件（节点网格、分组、拖拽预览）共用的上下文。

import type { DeviceFolder } from '@vibeterm/shared';
import { type ReactNode, createContext, useContext } from 'react';
import type { DeviceFolderContainer, DeviceFolderPlaceholder } from './folder-tree-model';
import type { NodeTileSize } from './node-grid';

export interface DeviceFolderNodeContext {
  /** 节点所在分组；null = 根层 */
  folderId: string | null;
  /** 该节点没有 placement（还挂在根层的默认位置上） */
  implicit: boolean;
  /** 上一次布局提交还在飞，拖拽应当禁用 */
  dragDisabled: boolean;
  /** 拖拽把手；宿主放进节点头部。不可拖时为 null */
  dragControls: ReactNode | null;
}

export interface TreeContextValue {
  containers: Map<string, DeviceFolderContainer>;
  foldersById: Map<string, DeviceFolder>;
  itemCounts: Map<string, number>;
  /** 有 placement 的节点 id：没有 placement 的节点还挂在根层的默认位置上 */
  placedNodeIds: ReadonlySet<string>;
  expandedOf: (folderId: string) => boolean;
  dropContainerId: string | null;
  /** 跨容器拖拽时占位条插在哪；同容器重排为 null */
  placeholder: DeviceFolderPlaceholder | null;
  dragDisabled: boolean;
  creatingFolder: boolean;
  renamingFolderId: string | null;
  renderNode: (nodeId: string, ctx: DeviceFolderNodeContext) => ReactNode;
  nodeDraggable?: (nodeId: string, ctx: { folderId: string | null }) => boolean;
  nodeLabel: (nodeId: string) => string;
  /** 节点磁贴在网格里想占几列（占位条也按被拖节点的这个值占位） */
  nodeSpan: (nodeId: string, folderId: string | null) => NodeTileSize;
  actions: {
    toggle: (folderId: string, expanded: boolean) => void;
    startRename: (folderId: string) => void;
    submitRename: (folderId: string, name: string) => void;
    cancelRename: () => void;
    submitNewFolder: (name: string) => void;
    cancelNewFolder: () => void;
    requestDelete: (folder: DeviceFolder) => void;
  };
}

export const TreeContext = createContext<TreeContextValue | null>(null);

export function useTree(): TreeContextValue {
  const value = useContext(TreeContext);
  if (!value) throw new Error('DeviceFolderTree 的子组件必须渲染在 DeviceFolderTree 内');
  return value;
}
