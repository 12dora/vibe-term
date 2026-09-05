// 分享日志的分页加载：一页页往后取，取到 `nextAfter === null` 为止。
// 边取边交给上层，长录像也能先看到开头，不必等整份下完。

import type { ShareLogEntry } from '@tmex/shared/share';
import { useRuntime } from '@tmex/stores/react';
import { useEffect, useState } from 'react';
import { fetchShareLogPage } from './share-api';

export interface ReplayLogState {
  entries: ShareLogEntry[];
  loading: boolean;
  error: string | null;
  /** 服务端记下的总条数；用于展示加载进度。 */
  total: number;
  /** 该分享的日志曾达到上限而停止记录。 */
  truncated: boolean;
}

const IDLE: ReplayLogState = {
  entries: [],
  loading: false,
  error: null,
  total: 0,
  truncated: false,
};

export function useReplayLog(shareId: string | null): ReplayLogState {
  const { apiClient } = useRuntime();
  const [state, setState] = useState<ReplayLogState>(IDLE);

  useEffect(() => {
    if (shareId === null) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    setState({ ...IDLE, loading: true });

    void (async () => {
      const entries: ShareLogEntry[] = [];
      let after: number | undefined;
      try {
        for (;;) {
          const page = await fetchShareLogPage(
            apiClient,
            shareId,
            after === undefined ? {} : { after },
            controller.signal
          );
          entries.push(...page.entries);
          const done = page.nextAfter === null || page.entries.length === 0;
          if (controller.signal.aborted) return;
          setState({
            entries: [...entries],
            loading: !done,
            error: null,
            total: page.total,
            truncated: page.truncated,
          });
          if (done) return;
          after = page.nextAfter ?? undefined;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          entries,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          total: entries.length,
          truncated: false,
        });
      }
    })();

    return () => controller.abort();
  }, [apiClient, shareId]);

  return state;
}
