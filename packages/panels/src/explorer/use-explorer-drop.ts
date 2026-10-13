// 拖放：系统文件拖入 = 上传；文件管理器内部拖拽 = 移动 / 复制（交给宿主执行）。
// 负责放置目标的高亮、dropEffect、悬停文件夹自动进入（弹簧加载），以及行拖拽源的载荷。

import type { FileEntryDto } from '@vibeterm/shared';
import type { DragEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dataTransferHasFiles } from '../files/file-tree-logic';
import type { ExplorerActions } from './actions';
import {
  type ExplorerDragPayload,
  type ExplorerDropDest,
  type SelectionState,
  getActiveDrag,
  hasExplorerDrag,
  isDirectoryEntry,
  readDragPayload,
  resolveDropKind,
  setActiveDrag,
  writeDragPayload,
} from './model';
import { type ExplorerTransferRequest, requestFromDrop } from './transfer-request';
import { useLatest } from './use-keyed-state';

/** 悬停在同一个文件夹行上多久后自动进入 */
export const SPRING_LOAD_MS = 900;

export type ExplorerDropAction = 'move' | 'copy' | 'upload';

export interface ExplorerDropState {
  /** 高亮的文件夹行；null = 整个内容区（放进当前目录） */
  targetPath: string | null;
  destDir: string;
  action: ExplorerDropAction;
}

export interface ExplorerDropOptions {
  nodeId: string;
  rootId: string;
  deviceId: string;
  /** 当前目录 */
  path: string;
  entries: readonly FileEntryDto[];
  selection: SelectionState;
  actions: Pick<ExplorerActions, 'uploadDataTransfer'>;
  destNames(dir: string): ReadonlySet<string> | null;
  onTransfer(request: ExplorerTransferRequest): void;
  onNavigate(path: string): void;
}

export interface ExplorerDropHandlers {
  drop: ExplorerDropState | null;
  onItemDragStart(entry: FileEntryDto, event: DragEvent): void;
  onItemDragEnd(event: DragEvent): void;
  onDragOverTarget(path: string | null, event: DragEvent): void;
  onDropTarget(path: string | null, event: DragEvent): void;
  onDragLeaveAll(): void;
  onDropOnCrumb(path: string, event: DragEvent): void;
  /** 视图不在时（空目录 / 加载中 / 出错）内容区自己当放置目标 */
  backgroundHandlers: {
    onDragOver(event: DragEvent): void;
    onDragLeave(event: DragEvent): void;
    onDrop(event: DragEvent): void;
  };
}

type CopyModifierEvent = Pick<DragEvent, 'altKey' | 'ctrlKey'>;

function copyModifier(event: CopyModifierEvent): boolean {
  return event.altKey || event.ctrlKey;
}

/**
 * dragover 阶段判断这次拖拽放到 `dest` 会发生什么；null = 不接受。
 * 内部拖拽读模块里的镜像载荷；镜像不在（从别的窗口拖来）时先按复制接受，真正的语义等 drop 再定。
 */
export function dropActionOf(
  dataTransfer: DataTransfer,
  active: ExplorerDragPayload | null,
  dest: ExplorerDropDest,
  copy: boolean
): ExplorerDropAction | null {
  if (hasExplorerDrag(dataTransfer)) {
    if (!active) return 'copy';
    const kind = resolveDropKind(active, dest, copy);
    return kind === 'none' ? null : kind;
  }
  return dataTransferHasFiles(dataTransfer.types) ? 'upload' : null;
}

/** 行拖拽的载荷：拖的是选中项就带上整个选择（按列表顺序），否则只带这一项。 */
export function dragPayloadOf(
  entry: FileEntryDto,
  options: Pick<
    ExplorerDropOptions,
    'nodeId' | 'rootId' | 'deviceId' | 'path' | 'entries' | 'selection'
  >
): ExplorerDragPayload {
  const { selected } = options.selection;
  const dragged = selected.has(entry.path)
    ? options.entries.filter((item) => selected.has(item.path))
    : [entry];
  return {
    nodeId: options.nodeId,
    rootId: options.rootId,
    deviceId: options.deviceId,
    dir: options.path,
    paths: dragged.map((item) => item.path),
    names: dragged.map((item) => item.name),
    hasDirectory: dragged.some(isDirectoryEntry),
  };
}

function sameDrop(a: ExplorerDropState | null, b: ExplorerDropState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.targetPath === b.targetPath && a.destDir === b.destDir && a.action === b.action;
}

interface SpringLoad {
  path: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function useSpringLoad(onFire: (path: string) => void) {
  const state = useRef<SpringLoad>({ path: null, timer: null });
  const onFireRef = useLatest(onFire);

  const cancel = useCallback(() => {
    const current = state.current;
    if (current.timer !== null) clearTimeout(current.timer);
    state.current = { path: null, timer: null };
  }, []);

  /** 每次 dragover 调：目标没变就让已有的计时器继续走 */
  const hover = useCallback(
    (path: string | null) => {
      if (state.current.path === path) return;
      cancel();
      if (path === null) return;
      const timer = setTimeout(() => {
        state.current = { path: null, timer: null };
        onFireRef.current(path);
      }, SPRING_LOAD_MS);
      state.current = { path, timer };
    },
    [cancel, onFireRef]
  );

  // 卸载后不能再有计时器触发导航
  useEffect(() => cancel, [cancel]);

  return useMemo(() => ({ hover, cancel }), [hover, cancel]);
}

/** 拖拽在别处结束（放到页面其它位置、按 Esc 取消）时也要收掉高亮 */
function useGlobalDragEnd(active: boolean, onEnd: () => void): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    document.addEventListener('dragend', onEnd, true);
    document.addEventListener('drop', onEnd, true);
    return () => {
      document.removeEventListener('dragend', onEnd, true);
      document.removeEventListener('drop', onEnd, true);
    };
  }, [active, onEnd]);
}

interface DropFeedback {
  setDrop(next: ExplorerDropState | null): void;
  /** 收掉高亮并取消弹簧加载 */
  clear(): void;
  hover(path: string | null): void;
}

function destOf(options: ExplorerDropOptions, dir: string): ExplorerDropDest {
  const { nodeId, deviceId, rootId } = options;
  return { nodeId, deviceId, rootId, dir };
}

function handleDragOver(
  options: ExplorerDropOptions,
  feedback: DropFeedback,
  targetPath: string | null,
  event: DragEvent
): void {
  const destDir = targetPath ?? options.path;
  const dest = destOf(options, destDir);
  const action = dropActionOf(event.dataTransfer, getActiveDrag(), dest, copyModifier(event));
  if (action === null) {
    // 不 preventDefault：浏览器显示「禁止」光标
    feedback.clear();
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = action === 'move' ? 'move' : 'copy';
  feedback.setDrop({ targetPath, destDir, action });
  feedback.hover(targetPath);
}

function handleDrop(
  options: ExplorerDropOptions,
  feedback: DropFeedback,
  destDir: string,
  event: DragEvent
): void {
  event.preventDefault();
  feedback.clear();
  const { dataTransfer } = event;
  if (!hasExplorerDrag(dataTransfer)) {
    // 必须在 drop 回调的同步阶段调用：条目句柄过后就读不到了
    if (dataTransferHasFiles(dataTransfer.types)) {
      void options.actions.uploadDataTransfer(dataTransfer, destDir);
    }
    return;
  }
  const payload = readDragPayload(dataTransfer) ?? getActiveDrag();
  // 拖拽源所在的视图可能已被弹簧加载换掉，收不到 dragend，这里顺手清镜像
  setActiveDrag(null);
  if (!payload) return;
  const dest = destOf(options, destDir);
  const kind = resolveDropKind(payload, dest, copyModifier(event));
  if (kind === 'none') return;
  options.onTransfer(requestFromDrop(payload, dest, kind, options.destNames(destDir)));
}

function useDropFeedback(latest: { readonly current: ExplorerDropOptions }) {
  const [drop, setDropState] = useState<ExplorerDropState | null>(null);
  const setDrop = useCallback((next: ExplorerDropState | null) => {
    // dragover 高频触发：内容没变就沿用旧引用，不引起重渲染
    setDropState((current) => (sameDrop(current, next) ? current : next));
  }, []);
  const spring = useSpringLoad((path) => {
    setDrop(null);
    latest.current.onNavigate(path);
  });
  const feedback = useMemo<DropFeedback>(
    () => ({
      setDrop,
      clear: () => {
        spring.cancel();
        setDrop(null);
      },
      hover: spring.hover,
    }),
    [setDrop, spring]
  );
  return { drop, feedback };
}

export function useExplorerDrop(options: ExplorerDropOptions): ExplorerDropHandlers {
  const latest = useLatest(options);
  const { drop, feedback } = useDropFeedback(latest);
  const { clear } = feedback;

  useGlobalDragEnd(drop !== null, clear);

  // 换目录后旧目录的高亮与计时器都作废
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅以位置变化为触发条件
  useEffect(() => clear, [options.rootId, options.path, clear]);

  return useMemo<ExplorerDropHandlers>(() => {
    const dragOver = (targetPath: string | null, event: DragEvent) =>
      handleDragOver(latest.current, feedback, targetPath, event);
    const dropInto = (destDir: string, event: DragEvent) =>
      handleDrop(latest.current, feedback, destDir, event);
    return {
      drop,
      onItemDragStart: (entry, event) => {
        const payload = dragPayloadOf(entry, latest.current);
        writeDragPayload(event.dataTransfer, payload);
        setActiveDrag(payload);
      },
      onItemDragEnd: () => {
        setActiveDrag(null);
        clear();
      },
      onDragOverTarget: dragOver,
      onDropTarget: (path, event) => dropInto(path ?? latest.current.path, event),
      onDragLeaveAll: clear,
      onDropOnCrumb: dropInto,
      backgroundHandlers: {
        onDragOver: (event) => dragOver(null, event),
        onDragLeave: (event) => {
          const next = event.relatedTarget as Node | null;
          if (!next || !event.currentTarget.contains(next)) clear();
        },
        onDrop: (event) => dropInto(latest.current.path, event),
      },
    };
  }, [drop, latest, feedback, clear]);
}
