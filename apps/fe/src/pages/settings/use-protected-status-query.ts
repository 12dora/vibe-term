// 设置页「受保护状态」查询的公共骨架。
//
// 本机运行态 / 内置 HTTPS / 远程访问三块的状态接口在 mesh 下都需要 self 会话，未登录一律返回
// 401。三者的生命周期完全一致：401 不重试、失败最多重试两次、靠 invalidate 刷新、把
// react-query 的状态投影成 `status/loading/loginRequired/error`。差异只在查询键、请求函数、
// 401 的判定方式，以及要不要 `enabled` / 轮询。
//
// 仓库没有 DOM 测试环境（hook 无法 render 测试），所以决策部分——重试判定、状态投影、缓存
// 动作——都写成可直接单测的纯函数，hook 本身只负责把它们接到 react-query 上。

import type { QueryKey } from '@tanstack/react-query';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

/** 三个设置页状态 hook 共享的对外形状。 */
export interface ProtectedStatusState<TStatus> {
  status: TStatus | null;
  loading: boolean;
  /** mesh 下未登录：给登录提示，不报错。 */
  loginRequired: boolean;
  error: string | null;
  refresh: () => void;
  setStatus: (next: TStatus) => void;
}

/** 失败最多重试两次；401 直接放弃——重试只会多刷几次登录拦截器。 */
export function protectedStatusRetry(
  isUnauthorized: (error: unknown) => boolean
): (failureCount: number, error: unknown) => boolean {
  return (failureCount, error) => !isUnauthorized(error) && failureCount < 2;
}

export interface ProtectedStatusProjectionInput<TStatus> {
  data: TStatus | undefined;
  error: unknown;
  isPending: boolean;
  enabled: boolean;
  isUnauthorized: (error: unknown) => boolean;
}

export type ProtectedStatusProjection<TStatus> = Pick<
  ProtectedStatusState<TStatus>,
  'status' | 'loading' | 'loginRequired' | 'error'
>;

export function projectProtectedStatus<TStatus>(
  input: ProtectedStatusProjectionInput<TStatus>
): ProtectedStatusProjection<TStatus> {
  const loginRequired = input.isUnauthorized(input.error);
  return {
    status: input.data ?? null,
    // 关掉查询时 react-query 也报 pending，但这时不该转圈。
    loading: input.enabled && input.isPending,
    loginRequired,
    error:
      !input.error || loginRequired
        ? null
        : input.error instanceof Error
          ? input.error.message
          : String(input.error),
  };
}

/** 只用到 QueryClient 的这两个方法；收窄成接口后无需真 client 即可单测。 */
export interface StatusQueryCache {
  invalidateQueries(filters: { queryKey: QueryKey }): unknown;
  setQueryData(queryKey: QueryKey, next: unknown): unknown;
}

export function refreshStatusQuery(cache: StatusQueryCache, queryKey: QueryKey): void {
  void cache.invalidateQueries({ queryKey });
}

export function writeStatusQuery<TStatus>(
  cache: StatusQueryCache,
  queryKey: QueryKey,
  next: TStatus
): void {
  cache.setQueryData(queryKey, next);
}

export interface ProtectedStatusQueryOptions<TStatus> {
  queryKey: QueryKey;
  queryFn: () => Promise<TStatus>;
  isUnauthorized: (error: unknown) => boolean;
  enabled?: boolean;
  /** 返回本次轮询间隔（毫秒）或 `false` 表示停轮询；不传即从不轮询。 */
  refetchInterval?: (data: TStatus | undefined) => number | false;
}

export function useProtectedStatusQuery<TStatus>(
  options: ProtectedStatusQueryOptions<TStatus>
): ProtectedStatusState<TStatus> {
  const { queryKey, queryFn, isUnauthorized, refetchInterval } = options;
  const enabled = options.enabled ?? true;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    retry: protectedStatusRetry(isUnauthorized),
    refetchInterval: refetchInterval ? (q) => refetchInterval(q.state.data) : undefined,
  });

  const refresh = useCallback(() => {
    refreshStatusQuery(queryClient, queryKey);
  }, [queryClient, queryKey]);

  const setStatus = useCallback(
    (next: TStatus) => {
      writeStatusQuery(queryClient, queryKey, next);
    },
    [queryClient, queryKey]
  );

  return {
    ...projectProtectedStatus<TStatus>({
      data: query.data,
      error: query.error,
      isPending: query.isPending,
      enabled,
      isUnauthorized,
    }),
    refresh,
    setStatus,
  };
}
