// 路由页模块按需加载：失败可重试，且旧路由的 chunk 落地不得覆盖当前路由。

import { type ComponentType, useCallback, useEffect, useState } from 'react';

export type PageRouteParams = Readonly<Record<string, string | undefined>>;

export interface PageModule {
  default?: ComponentType;
  PageTitle?: ComponentType<PageRouteParams>;
  PageActions?: ComponentType<PageRouteParams>;
}

export type PageModuleLoader = () => Promise<PageModule>;

export type PageModuleState =
  | { status: 'loading'; module: null; error: null }
  | { status: 'ready'; module: PageModule; error: null }
  | { status: 'error'; module: null; error: Error };

export const PAGE_MODULE_LOADING: PageModuleState = {
  status: 'loading',
  module: null,
  error: null,
};

export function toPageModuleError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

// 已解析的页模块按 loader 记一份：切走再切回来必须**同步**就是 ready。
// 没有它，每次进同一个路由都会先渲染一帧 loading，`page-wrapper` 的 `key={state.status}`
// 随之翻一次，整块内容重挂并重播 150ms 入场动画。
const resolvedModules = new Map<PageModuleLoader, PageModule>();

export function cachedPageModule(loader: PageModuleLoader): PageModule | null {
  return resolvedModules.get(loader) ?? null;
}

/** 首帧状态：命中缓存直接 ready，否则维持原有的 loading 起点。 */
export function initialPageModuleState(loader: PageModuleLoader): PageModuleState {
  const module = resolvedModules.get(loader);
  return module ? { status: 'ready', module, error: null } : PAGE_MODULE_LOADING;
}

/** 仅供测试：清掉模块级缓存，避免用例之间互相污染。 */
export function clearPageModuleCache(): void {
  resolvedModules.clear();
}

// 懒路由 chunk 之外的前置条件（i18n rest 语言包）。由 `@/i18n` 在启动时注入：
// 这里不能静态 import 它——那个模块用的是 vite 专属的 import.meta.glob，进不了单测环境。
// 未注入时保持原有时序，一个 then 直达 ready。
let pageModulePrerequisite: (() => Promise<unknown>) | null = null;

export function setPageModulePrerequisite(prerequisite: (() => Promise<unknown>) | null): void {
  pageModulePrerequisite = prerequisite;
}

/** 发起一次加载并返回取消函数：取消后 resolve/reject 都不再写状态 */
export function requestPageModule(
  loader: PageModuleLoader,
  apply: (state: PageModuleState) => void
): () => void {
  let cancelled = false;
  const pending = loader();
  // 语言包失败不该拖垮页面：前置条件只等，不参与失败判定。
  const ready = pageModulePrerequisite
    ? Promise.all([pending, pageModulePrerequisite().catch(() => undefined)]).then(
        ([module]) => module
      )
    : pending;
  void ready.then(
    (module) => {
      resolvedModules.set(loader, module);
      if (!cancelled) apply({ status: 'ready', module, error: null });
    },
    (reason: unknown) => {
      if (!cancelled) apply({ status: 'error', module: null, error: toPageModuleError(reason) });
    }
  );
  return () => {
    cancelled = true;
  };
}

type ApplyPageModuleState = (
  update: PageModuleState | ((prev: PageModuleState) => PageModuleState)
) => void;

/**
 * 挂载 / 换路由时的同步动作（`usePageModule` 的 effect 主体）：
 * 命中缓存就把状态校准到 ready，否则发起一次加载并返回取消函数。
 *
 * 校准这一步不能省：render 与 effect 之间缓存可能才刚落地——上一次被取消的加载仍会写缓存，
 * 却不会回写组件状态，此时状态还停在 loading，页面永远没内容。
 * 已经对上同一个模块时返回原对象，React 直接跳过重渲染。
 */
export function syncPageModuleState(
  loader: PageModuleLoader,
  apply: ApplyPageModuleState
): (() => void) | undefined {
  const cached = cachedPageModule(loader);
  if (cached) {
    apply((prev) =>
      prev.status === 'ready' && prev.module === cached
        ? prev
        : { status: 'ready', module: cached, error: null }
    );
    return undefined;
  }
  apply(PAGE_MODULE_LOADING);
  return requestPageModule(loader, apply);
}

export interface PageModuleResult {
  state: PageModuleState;
  retry: () => void;
}

export function usePageModule(moduleLoader: PageModuleLoader): PageModuleResult {
  const [state, setState] = useState<PageModuleState>(() => initialPageModuleState(moduleLoader));
  const [attempt, setAttempt] = useState(0);
  // 换路由时 loader 变了：在渲染期就把状态切到新 loader 的起点，
  // 否则这一帧还会渲染上一个页面的模块，命中缓存也白搭。
  // 装在对象里：useState 会把裸函数当成惰性初始化器直接调用掉。
  const [activeLoader, setActiveLoader] = useState(() => ({ loader: moduleLoader }));
  if (activeLoader.loader !== moduleLoader) {
    setActiveLoader({ loader: moduleLoader });
    setState(initialPageModuleState(moduleLoader));
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 是显式重试触发器
  useEffect(() => syncPageModuleState(moduleLoader, setState), [moduleLoader, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { state, retry };
}
