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

export interface PageModuleResult {
  state: PageModuleState;
  retry: () => void;
}

export function usePageModule(moduleLoader: PageModuleLoader): PageModuleResult {
  const [state, setState] = useState<PageModuleState>(PAGE_MODULE_LOADING);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 是显式重试触发器
  useEffect(() => {
    setState(PAGE_MODULE_LOADING);
    return requestPageModule(moduleLoader, setState);
  }, [moduleLoader, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { state, retry };
}
