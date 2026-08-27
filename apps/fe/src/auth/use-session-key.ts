// 会话钥 / 登录进度 / auth mode 的 React 绑定。

import type { AuthApi, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { NodeLoginProgress, SessionKeyInfo } from './session-key-store';
import {
  getLoginProgress,
  getSessionKeySnapshot,
  subscribeLoginProgress,
  subscribeSessionKey,
} from './session-key-store';

export function useSessionKey(): SessionKeyInfo | null {
  return useSyncExternalStore(subscribeSessionKey, getSessionKeySnapshot, getSessionKeySnapshot);
}

export function useLoginProgress(): NodeLoginProgress[] {
  return useSyncExternalStore(subscribeLoginProgress, getLoginProgress, getLoginProgress);
}

export interface AuthModeState {
  mode: AuthModeResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** 拉取 `/api/auth/mode`。standalone（`mode==='none'`）下所有登录 UI 都不渲染。 */
export function useAuthMode(
  api: AuthApi = defaultAuthApi,
  options: { enabled?: boolean } = {}
): AuthModeState {
  const enabled = options.enabled ?? true;
  const [mode, setMode] = useState<AuthModeResponse | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((): (() => void) => {
    if (!enabled) {
      setLoading(false);
      return () => undefined;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getMode()
      .then((next) => {
        if (cancelled) return;
        setMode(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, enabled]);

  useEffect(() => load(), [load]);
  return { mode, loading, error, reload: load };
}
