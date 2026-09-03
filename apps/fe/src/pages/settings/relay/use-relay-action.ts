// 中继写操作的公共状态：一次一个动作，成败都留在调用点自己的卡片 / 对话框里。
//
// 不走 react-query 的 mutation：这些写接口没有缓存语义，成功后一律重拉 status 取权威值。

import { useCallback, useState } from 'react';

export interface RelayAction {
  busy: boolean;
  /** 失败原因（已是可展示文本）；成功或重置后为 `null`。 */
  error: string | null;
  reset: () => void;
  /** 跑一次写操作；成功返回 true。 */
  run: (task: () => Promise<void>) => Promise<boolean>;
}

export function useRelayAction(): RelayAction {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => setError(null), []);

  const run = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, reset, run };
}
