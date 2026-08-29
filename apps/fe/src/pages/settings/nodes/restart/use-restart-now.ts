// 重启等待的 React 封装。卸载即 abort：只压住 setState 是不够的，在途的 `/healthz` 也必须断掉。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { readStartedAt, waitForRestart } from './wait-for-restart';

export type RestartState = 'idle' | 'waiting' | 'restarted' | 'timeout';

export interface RestartNow {
  state: RestartState;
  waiting: boolean;
  elapsedMs: number;
  /** 传入提交前读到的 startedAt（读不到传 null）后开始等待。 */
  start: (previousStartedAt: number | null) => void;
  cancel: () => void;
}

export interface UseRestartNowOptions {
  client?: ApiClient;
  timeoutMs?: number;
  intervalMs?: number;
  onRestarted?: () => void;
}

export function useRestartNow(options: UseRestartNowOptions = {}): RestartNow {
  const { client = defaultApiClient, timeoutMs, intervalMs, onRestarted } = options;
  const [state, setState] = useState<RestartState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const onRestartedRef = useRef(onRestarted);
  onRestartedRef.current = onRestarted;

  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    []
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState('idle');
    setElapsedMs(0);
  }, []);

  const start = useCallback(
    (previousStartedAt: number | null) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState('waiting');
      setElapsedMs(0);
      void waitForRestart({
        previousStartedAt,
        fetchImpl: (path, init) => client.fetch(path, init),
        signal: controller.signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(intervalMs === undefined ? {} : { intervalMs }),
        onElapsed: (ms) => {
          if (!controller.signal.aborted) setElapsedMs(ms);
        },
      }).then((outcome) => {
        if (controller.signal.aborted || outcome === 'aborted') return;
        abortRef.current = null;
        setState(outcome === 'restarted' ? 'restarted' : 'timeout');
        if (outcome === 'restarted') onRestartedRef.current?.();
      });
    },
    [client, intervalMs, timeoutMs]
  );

  return { state, waiting: state === 'waiting', elapsedMs, start, cancel };
}

export interface RestartGateway {
  state: RestartState;
  waiting: boolean;
  run: () => Promise<void>;
}

/**
 * 「立即重启」按钮：先记下当前 `startedAt`，POST `/api/settings/restart`，再等新进程回来。
 * 顺序不能反——响应回来时进程可能已经退出，那时再读到的就是新进程的 startedAt。
 */
export function useRestartGateway(
  client: ApiClient = defaultApiClient,
  onRestarted: () => void = () => undefined
): RestartGateway {
  const { t } = useTranslation();
  const restart = useRestartNow({ client, onRestarted });
  const [posting, setPosting] = useState(false);
  const { start } = restart;

  const run = useCallback(async () => {
    setPosting(true);
    const before = await readStartedAt((path, init) => client.fetch(path, init));
    try {
      const res = await client.fetch('/api/settings/restart', { method: 'POST' });
      if (!res.ok) throw new Error(t('settings.restartFailed'));
    } catch (err) {
      setPosting(false);
      toast.error(err instanceof Error ? err.message : t('settings.restartFailed'));
      return;
    }
    setPosting(false);
    start(before);
  }, [client, start, t]);

  const state = posting ? 'waiting' : restart.state;
  return { state, waiting: state === 'waiting', run };
}
