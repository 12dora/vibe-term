// 文件树的共享右键菜单：整棵树只挂**一个** ContextMenu（Root + Trigger）。
//
// 每行一个 `ContextMenu.Root + Trigger` 时，500 行的 SSR 是纯按钮的 17 倍（1.74ms → 29.18ms，
// 见 EX1 §U5）。这里把 Trigger 提到树根：右键与长按手势仍由 base-ui 的 Trigger 提供（500ms
// 长按、10px 位移阈值一字未改），打开时按事件目标从目录列表缓存回查 entry；打开文件、拖到 OS
// 下载同样走事件委托，于是行退化成一个不带任何回调的 `<button>`。
//
// 命中的 entry 存在一个外部 store 里，只有菜单内容组件订阅它——直接放进本组件的 state 会让每次
// 右键都重渲染整棵树，把这里省下的开销原样赔回去（本组件不重渲染时，`ContextMenu` 自身的状态
// 变化不会波及 children：元素引用没变，React 直接 bail 掉整棵子树）。
//
// 目录行仍保留各自的 ContextMenu（数量与展开的目录数同阶，不是热点）。两层 ContextMenu 嵌套是
// 安全的：base-ui 的 menu store 只在 `parent.type === 'menu'`（真子菜单）时才共用
// `floatingTreeRoot`，context menu 各自持有独立的事件总线；目录行的 Trigger 又会 stopPropagation，
// 事件不会同时落到两层。

import { useQueryClient } from '@tanstack/react-query';
import type { FileEntryDto, FileRootDto, ListFilesResponse } from '@tmex/shared';
import { fileRoute, hostAppPath } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import { ContextMenu, ContextMenuTrigger } from '@tmex/ui/context-menu';
import { useSidebar } from '@tmex/ui/sidebar';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useNavigate } from 'react-router';
import {
  type FileLeafTarget,
  type LeafHit,
  armFileLeafMenu,
  hitFileLeaf,
  markOpenRow,
} from './file-leaf-delegates';
import type { AttrElement } from './file-leaf-target';
import { FileNodeMenuContent, useFileNodeActions } from './file-node-actions';
import { fileListQueryKey } from './use-directory-listing';

type TriggerProps = ComponentProps<typeof ContextMenuTrigger>;
type ContextMenuEvt = Parameters<NonNullable<TriggerProps['onContextMenu']>>[0];
type TouchEvt = Parameters<NonNullable<TriggerProps['onTouchStart']>>[0];
type MouseEvt = Parameters<NonNullable<TriggerProps['onClick']>>[0];
type DragEvt = Parameters<NonNullable<TriggerProps['onDragStart']>>[0];

interface TargetStore {
  get: () => FileLeafTarget | null;
  set: (next: FileLeafTarget | null) => void;
  subscribe: (listener: () => void) => () => void;
}

function createTargetStore(): TargetStore {
  let current: FileLeafTarget | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      if (current === next) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const nullSnapshot = (): FileLeafTarget | null => null;

export interface FileLeafContextMenuProps {
  /** 当前渲染出的根目录；解析命中行时按 id 回查 */
  roots: readonly FileRootDto[];
  className?: string;
  children: ReactNode;
}

export function FileLeafContextMenu({ roots, className, children }: FileLeafContextMenuProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const runtime = useRuntime();
  const { isMobile, setOpenMobile } = useSidebar();
  const actions = useFileNodeActions();
  const [store] = useState(createTargetStore);

  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const openRowRef = useRef<AttrElement | null>(null);

  const hit = useCallback(
    (eventTarget: EventTarget | null): LeafHit | null =>
      hitFileLeaf(eventTarget, rootsRef.current, (rootId, dir) =>
        queryClient.getQueryData<ListFilesResponse>(fileListQueryKey(rootId, dir))
      ),
    [queryClient]
  );

  const openFile = useCallback(
    (target: FileLeafTarget) => {
      navigate(hostAppPath(runtime.host, fileRoute(target.root.id, target.entry.path)));
      if (isMobile) setOpenMobile(false);
    },
    [navigate, runtime.host, isMobile, setOpenMobile]
  );

  // 右键 / 长按：命中文件行才把手势交回 base-ui，否则挡掉——否则长按「显示其余」这类填充行
  // 也会弹出上一次命中的那份菜单。
  const arm = useCallback(
    (event: ContextMenuEvt | TouchEvt, touches?: number): void => {
      const armed = armFileLeafMenu(hit(event.target), touches, () => event.preventBaseUIHandler());
      if (!armed) return;
      markOpenRow(openRowRef.current, false);
      openRowRef.current = armed.row;
      store.set(armed.target);
    },
    [hit, store]
  );

  const handlers = useMemo(
    () => ({
      onClick: (event: MouseEvt) => {
        const found = hit(event.target);
        if (found) openFile(found.target);
      },
      onContextMenu: (event: ContextMenuEvt) => arm(event),
      onTouchStart: (event: TouchEvt) => arm(event, event.touches.length),
      onDragStart: (event: DragEvt) => {
        const found = hit(event.target);
        if (found) actions.onDragStart(event, found.target.root.id, found.target.entry);
      },
      onDragEnd: (event: DragEvt) => {
        const found = hit(event.target);
        if (found) actions.onDragEnd(event, found.target.entry);
      },
    }),
    [hit, arm, openFile, actions]
  );

  const onOpenChange = useCallback((open: boolean) => markOpenRow(openRowRef.current, open), []);

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger className={className} {...handlers}>
        {children}
      </ContextMenuTrigger>
      <FileLeafMenu store={store} onOpen={openFile} onDownload={actions.download} />
    </ContextMenu>
  );
}

function FileLeafMenu({
  store,
  onOpen,
  onDownload,
}: {
  store: TargetStore;
  onOpen: (target: FileLeafTarget) => void;
  onDownload: (rootId: string, entry: FileEntryDto) => Promise<void>;
}) {
  const target = useSyncExternalStore(store.subscribe, store.get, nullSnapshot);
  if (!target) return null;
  return (
    <FileNodeMenuContent
      root={target.root}
      entry={target.entry}
      onOpen={() => onOpen(target)}
      onDownload={() => void onDownload(target.root.id, target.entry)}
    />
  );
}
