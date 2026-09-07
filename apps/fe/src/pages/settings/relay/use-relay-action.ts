// 中继写操作的公共状态：一次一个动作，成败都留在调用点自己的卡片 / 对话框里。
//
// 不走 react-query 的 mutation：这些写接口没有缓存语义，成功后一律重拉 status 取权威值。

import { errorMessage } from '@vibeterm/shared';
import { useCallback, useState } from 'react';

/**
 * 一次写操作的结论。失败带上**原始异常**：`relay_members_offline` 这种 409 里还有人数，
 * 只留一句已格式化的文本就读不出来了（`error` state 会晚一帧，不能在 await 之后就地读）。
 */
export type RelayRunOutcome = { ok: true } | { ok: false; error: unknown };

export interface RelayAction {
  busy: boolean;
  /** 失败原因（已是可展示文本）；成功或重置后为 `null`。 */
  error: string | null;
  reset: () => void;
  /** 跑一次写操作。 */
  run: (task: () => Promise<void>) => Promise<RelayRunOutcome>;
}

export function useRelayAction(): RelayAction {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => setError(null), []);

  const run = useCallback(async (task: () => Promise<void>): Promise<RelayRunOutcome> => {
    setBusy(true);
    setError(null);
    try {
      await task();
      return { ok: true };
    } catch (err) {
      setError(errorMessage(err));
      return { ok: false, error: err };
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, reset, run };
}
