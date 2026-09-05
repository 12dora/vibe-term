// auth mode 的 React 绑定。

import type { AuthApi, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { errorMessage } from '@tmex/shared';
import { useCallback, useEffect, useState } from 'react';

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
        setError(errorMessage(err));
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
