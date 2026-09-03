// 文件树的共享右键菜单：整棵树只挂**一个** ContextMenu。
//
// 每行一个 `ContextMenu.Root + Trigger` 时，500 行的 SSR 是纯按钮的 17 倍（1.74ms → 29.18ms，
// 见 EX1 §U5）。这里把菜单提到树根：打开时按事件目标从目录列表缓存回查 entry；打开文件、拖到 OS
// 下载同样走事件委托，于是行退化成一个不带任何回调的 `<button>`。
//
// Trigger **不能**包住整棵树：base-ui 的 Trigger 会挂一条 document 级 `contextmenu` 监听，
// 对 Trigger 内的**所有**元素调 `preventDefault()`。包住整棵树的话，空目录、加载行、
// 「显示其余」和空白区域右键后既没有应用菜单，也没有浏览器原生菜单。
// 改成：Trigger 只是一个 0 尺寸的锚点，命中文件行时由委托主动给它派发一次 `contextmenu`
// （锚点坐标 = 指针坐标）；没命中就一个字节都不碰，原生菜单照常弹。
// 开合、定位、mouseup 语义仍全是 base-ui 的原代码，本文件只负责「命中才发」。
//
// 触摸长按同理：Trigger 收不到 touch 事件了，长按由 `createLongPress` 在树根复刻
// （500ms / 10px，与 base-ui 一致），触发后同样派发 `contextmenu`。
//
// 命中的 entry 存在一个外部 store 里，只有菜单内容组件订阅它——直接放进本组件的 state 会让每次
// 右键都重渲染整棵树，把这里省下的开销原样赔回去（本组件不重渲染时，`ContextMenu` 自身的状态
// 变化不会波及 children：元素引用没变，React 直接 bail 掉整棵子树）。
//
// 目录行仍保留各自的 ContextMenu（数量与展开的目录数同阶，不是热点）。

import { useQueryClient } from '@tanstack/react-query';
import type { FileEntryDto, FileRootDto, ListFilesResponse } from '@tmex/shared';
import { fileRoute, hostAppPath } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import { ContextMenu, ContextMenuTrigger } from '@tmex/ui/context-menu';
import { useSidebar } from '@tmex/ui/sidebar';
import {
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useNavigate } from 'react-router';
import {
  type FileLeafTarget,
  type LeafHit,
  type PointerPoint,
  createLongPress,
  hitFileLeaf,
  markOpenRow,
  shouldArmLongPress,
} from './file-leaf-delegates';
import type { AttrElement } from './file-leaf-target';
import { type FileNodeActions, FileNodeMenuContent, useFileNodeActions } from './file-node-actions';
import { fileListQueryKey } from './use-directory-listing';

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

// iOS 长按的系统气泡：原来由 base-ui Trigger 的内联样式关掉，Trigger 移走后在这里补上
const TREE_STYLE: CSSProperties = { WebkitTouchCallout: 'none' };

export interface FileLeafContextMenuProps {
  /** 当前渲染出的根目录；解析命中行时按 id 回查 */
  roots: readonly FileRootDto[];
  className?: string;
  children: ReactNode;
}

type LeafHitTest = (eventTarget: EventTarget | null) => LeafHit | null;

/** 树根一处接管 click / contextmenu / 长按 / 拖拽：未命中文件行时一律原样放行 */
function useLeafGestureHandlers({
  hit,
  openFile,
  openMenu,
  actions,
}: {
  hit: LeafHitTest;
  openFile: (target: FileLeafTarget) => void;
  openMenu: (found: LeafHit, point: PointerPoint) => void;
  actions: FileNodeActions;
}) {
  const openMenuRef = useRef(openMenu);
  openMenuRef.current = openMenu;
  const [longPress] = useState(() =>
    createLongPress<LeafHit>({
      onFire: (found, point) => openMenuRef.current(found, point),
    })
  );
  useEffect(() => () => longPress.cancel(), [longPress]);

  return useMemo(
    () => ({
      onClick: (event: ReactMouseEvent<HTMLElement>) => {
        const found = hit(event.target);
        if (found) openFile(found.target);
      },
      // 未命中文件行时一个字节都不碰：浏览器原生菜单照常弹
      onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
        const found = hit(event.target);
        if (!found) return;
        event.preventDefault();
        openMenu(found, { clientX: event.clientX, clientY: event.clientY });
      },
      onTouchStart: (event: ReactTouchEvent<HTMLElement>) => {
        longPress.cancel();
        const touch = event.touches[0];
        const found = hit(event.target);
        if (!touch || !shouldArmLongPress(found, event.touches.length)) return;
        longPress.start(found, { clientX: touch.clientX, clientY: touch.clientY });
      },
      onTouchMove: (event: ReactTouchEvent<HTMLElement>) => {
        const touch = event.touches[0];
        if (event.touches.length !== 1 || !touch) {
          longPress.cancel();
          return;
        }
        longPress.move({ clientX: touch.clientX, clientY: touch.clientY });
      },
      // 长按已经把菜单弹出来了：抑制合成的 mouse 序列，否则 mouseup 会立刻把它关掉
      onTouchEnd: (event: ReactTouchEvent<HTMLElement>) => {
        if (longPress.consumeFired() && event.cancelable) event.preventDefault();
        longPress.cancel();
      },
      onTouchCancel: () => {
        longPress.consumeFired();
        longPress.cancel();
      },
      onDragStart: (event: DragEvent<HTMLElement>) => {
        const found = hit(event.target);
        if (found) actions.onDragStart(event, found.target.root.id, found.target.entry);
      },
      onDragEnd: (event: DragEvent<HTMLElement>) => {
        const found = hit(event.target);
        if (found) actions.onDragEnd(event, found.target.entry);
      },
    }),
    [hit, openFile, openMenu, longPress, actions]
  );
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
  const anchorRef = useRef<HTMLDivElement | null>(null);

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

  const openMenuAt = useCallback(
    (found: LeafHit, point: PointerPoint) => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      markOpenRow(openRowRef.current, false);
      openRowRef.current = found.row;
      store.set(found.target);
      anchor.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: point.clientX,
          clientY: point.clientY,
        })
      );
    },
    [store]
  );

  const handlers = useLeafGestureHandlers({ hit, openFile, openMenu: openMenuAt, actions });

  const onOpenChange = useCallback((open: boolean) => markOpenRow(openRowRef.current, open), []);

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger
        className="pointer-events-none fixed top-0 left-0 h-0 w-0"
        render={<div ref={anchorRef} tabIndex={-1} />}
      />
      <div className={className} style={TREE_STYLE} {...handlers}>
        {children}
      </div>
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
