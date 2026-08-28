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

/** 发起一次加载并返回取消函数：取消后 resolve/reject 都不再写状态 */
export function requestPageModule(
  loader: PageModuleLoader,
  apply: (state: PageModuleState) => void
): () => void {
  let cancelled = false;
  void loader().then(
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
