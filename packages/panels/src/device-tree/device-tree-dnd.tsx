// 设备树拖拽的门面：把 @dnd-kit（core + sortable + utilities，约 17 KB gz）挪出首屏 chunk。
//
// 侧栏是常驻组件，`SortableVerticalList` / `useSortableRow` 从 main.tsx 静态可达，于是整个
// dnd-kit 被打进首屏那个唯一的、阻塞渲染的 `<script>`——而绝大多数会话里用户一次都不拖。
// 这里只留一层空壳：真正的实现（`device-tree-dnd-impl`）走动态 import，首屏不下载。
//
// 加载前后如何切换：
//   - 未加载：`SortableVerticalList` 原样渲染 children，行照常可点、可滚、可键盘导航，
//     只是没有拖拽 ref / listeners；`useSortableRow` 返回同形状的空样板（保留
//     role/tabIndex，焦点顺序不变）。
//   - 加载后：换成真正的 `DndContext` + `SortableContext`。children 在树里的位置变了，
//     React 必然重挂一次这棵子树——这是**无法回避**的：`useSortable` 内部的 hook 数量
//     与空样板不同，同一个组件实例上换实现会触发「渲染的 hook 比上次多」。
//     行本身没有局部状态（展开态在 store 里），远端分节的运行时经 `useNodeRuntime`
//     引用计数 + 宽限期释放，秒级内的重挂不会真的断连。
//
// 为什么不按「首次 pointerdown / pointerenter 再加载」：那样重挂会发生在手势中途。
// mousedown 落在旧 DOM 节点上、mouseup 落在新节点上，浏览器不会派发 click——用户在侧栏的
// **第一次点击**会被静默吞掉，比省下这一次预取严重得多。改为首帧提交后立刻发起 import：
// 首屏 `<script>` 已经不含它（这才是要优化的量），chunk 在用户来得及交互之前就已就位。
// 代价：极慢的链路上，chunk 到达前的第一个拖拽手势不会有任何反应（不是报错，是没反应），
// 松手重拖即可。
//
// 加载失败怎么办：侧栏是常驻组件，一次失败若不重试，整个页面生命周期内拖拽就永久失效，
// 而且没有任何提示。这里做两道恢复：
//   1) 指数退避自动重试（有限次）——瞬时网络抖动自己会好；
//   2) 用户真的去碰拖拽手柄时立刻重试一次（`requestDeviceTreeDnd`），不受退避次数限制。
// 侧栏里不放任何错误 UI：拖拽是增强功能，为它在常驻侧栏挂一条报错横幅得不偿失。
// 注意发版后旧 chunk 404 这类「就地重试也没用」的情形（浏览器把失败的模块 URL 记进
// module map），退避封顶后就不再空转，等用户整页刷新拿到新 index.html 自然恢复。

import { createContext, useContext, useEffect, useState } from 'react';
import type * as DeviceTreeDndImpl from './device-tree-dnd-impl';

// 只透传类型（`import type` 全部擦除）。**不要**在这里 re-export 实现里的值：
// 一个模块只要被入口静态可达，rollup 就会把它并进首屏 chunk，动态 import 退化成引用同一块，
// 拆分直接失效（@dnd-kit 三个包都没有 `sideEffects: false`，摇不掉）。
// 拖拽过程里才用的 `reorderIdsByDragEnd` / `pointerFirstCollisionDetection` /
// `restrictToVerticalAxis` / `useDeviceTreeSensors` 一律从 `./device-tree-dnd-impl` 直接引，
// 现有消费者只有 `device-folders`（本身就在懒加载页里）与单测。

export type SortableRow = DeviceTreeDndImpl.SortableRow;
export type SortableVerticalListProps = DeviceTreeDndImpl.SortableVerticalListProps;

type DndImplModule = typeof DeviceTreeDndImpl;

/** 自动退避重试的次数上限；超过后只有用户碰手柄才会再试 */
export const MAX_DND_AUTO_RETRIES = 4;
const RETRY_BASE_MS = 800;
const RETRY_MAX_MS = 30_000;

type DndImplImporter = () => Promise<DndImplModule>;

const defaultImporter: DndImplImporter = () => import('./device-tree-dnd-impl');

let importImpl: DndImplImporter = defaultImporter;
let loadedImpl: DndImplModule | null = null;
let inflight: Promise<DndImplModule> | null = null;
let failureCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const readyListeners = new Set<() => void>();

/** 第 n 次失败后的退避时长；封顶 30s，避免离线时空转 */
export function dndRetryDelayMs(failures: number): number {
  const shift = Math.min(Math.max(failures - 1, 0), 16);
  return Math.min(RETRY_BASE_MS * 2 ** shift, RETRY_MAX_MS);
}

/** 拉取拖拽实现；失败不缓存，下一次请求会重新发起。 */
export function loadDeviceTreeDnd(): Promise<DndImplModule> {
  if (loadedImpl) return Promise.resolve(loadedImpl);
  if (!inflight) {
    inflight = importImpl().then(
      (module) => {
        loadedImpl = module;
        inflight = null;
        return module;
      },
      (error: unknown) => {
        inflight = null;
        throw error;
      }
    );
  }
  return inflight;
}

function scheduleRetry(): void {
  if (retryTimer !== null || loadedImpl || failureCount > MAX_DND_AUTO_RETRIES) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    requestDeviceTreeDnd();
  }, dndRetryDelayMs(failureCount));
}

/**
 * 请求加载拖拽实现：已就位直接返回，失败则记一次并排一次退避重试。
 * 用户触碰拖拽手柄时也会调它——那一次不受退避计数限制，且会抢在待办的退避之前发起。
 */
export function requestDeviceTreeDnd(): void {
  if (loadedImpl) return;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  void loadDeviceTreeDnd().then(
    () => {
      failureCount = 0;
      for (const listener of readyListeners) listener();
    },
    () => {
      failureCount += 1;
      scheduleRetry();
    }
  );
}

/** 仅供测试：替换动态 import（传 null 恢复默认） */
export function setDeviceTreeDndImporterForTests(importer: DndImplImporter | null): void {
  importImpl = importer ?? defaultImporter;
}

/** 仅供测试：清掉模块级缓存与重试状态，让下一次挂载重新走一遍加载。 */
export function resetDeviceTreeDndForTests(): void {
  importImpl = defaultImporter;
  loadedImpl = null;
  inflight = null;
  failureCount = 0;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  readyListeners.clear();
}

/** 仅供测试：观察退避重试状态 */
export function deviceTreeDndLoadStateForTests(): {
  loaded: boolean;
  failures: number;
  retryScheduled: boolean;
} {
  return {
    loaded: loadedImpl !== null,
    failures: failureCount,
    retryScheduled: retryTimer !== null,
  };
}

// 行读的是**祖先容器渲染时用的那份实现**，不是模块级变量：否则容器还在空壳分支、行已经
// 读到实现，`useSortable` 就会跑在没有 DndContext 的树里。
const DndImplContext = createContext<DndImplModule | null>(null);

const noopRef = (): void => undefined;

// 空样板保留 dnd-kit 的 role/tabIndex/aria-roledescription，加载前后焦点顺序与语义一致。
// 不带 `aria-describedby`：它指向 DndContext 挂的说明节点，这会儿那个节点还不存在，
// 填上就是一条悬空引用。
// 手柄上的 pointerdown / keydown 兼作「用户真的想拖」的信号：实现还没就位（多半是之前加载
// 失败了）时立刻再试一次，不必等退避到期，也不必刷新页面。
const retryOnInteraction = (): void => requestDeviceTreeDnd();

const idleDragHandleProps = {
  ...({
    role: 'button',
    tabIndex: 0,
    'aria-disabled': false,
    'aria-pressed': undefined,
    'aria-roledescription': 'sortable',
  } as SortableRow['dragHandleProps']),
  onPointerDown: retryOnInteraction,
  onKeyDown: retryOnInteraction,
};

const idleSortableRow: SortableRow = {
  setNodeRef: noopRef,
  setDragHandleRef: noopRef,
  style: { transform: undefined, transition: undefined },
  isDragging: false,
  dragHandleProps: idleDragHandleProps,
};

function useDndImpl(): DndImplModule | null {
  const [impl, setImpl] = useState<DndImplModule | null>(loadedImpl);

  useEffect(() => {
    if (impl) return;
    let cancelled = false;
    // 订阅模块级的「就位」广播：重试可能由别处（另一个列表、手柄交互、退避定时器）发起，
    // 单纯 await 自己这一次 promise 会漏掉那些成功。
    const onReady = () => {
      if (!cancelled && loadedImpl) setImpl(loadedImpl);
    };
    readyListeners.add(onReady);
    requestDeviceTreeDnd();
    onReady();
    return () => {
      cancelled = true;
      readyListeners.delete(onReady);
    };
  }, [impl]);

  return impl;
}

/** 设备树三层共用的竖向排序容器；自身不产生 DOM 节点。实现未就位时原样渲染 children。 */
export function SortableVerticalList(props: SortableVerticalListProps) {
  const impl = useDndImpl();

  if (!impl) {
    return <DndImplContext.Provider value={null}>{props.children}</DndImplContext.Provider>;
  }

  const List = impl.SortableVerticalList;
  return (
    <DndImplContext.Provider value={impl}>
      <List {...props} />
    </DndImplContext.Provider>
  );
}

/**
 * 行级 sortable 样板：外层容器 ref/transform + 拖拽手柄 props。
 *
 * 实现未就位时返回不可拖的同形状样板。这里的条件 hook 调用是安全的：`impl` 只可能随
 * `SortableVerticalList` 换分支而变，那一刻整棵 children 已经被重挂，组件实例是全新的。
 */
export function useSortableRow(id: string): SortableRow {
  const impl = useContext(DndImplContext);
  if (!impl) return idleSortableRow;
  return impl.useSortableRow(id);
}
