// 升级前那一次确认的闸门：把「弹框等用户拍板」这件事变成一个可 await 的端口。
//
// 行内升级与批量升级共用同一个闸门（由 `useNodeUpgrade` 建一份传给两段），确认框任一时刻
// 只会开一个；两条路径的准入判定都留在各自的纯函数 launcher 里，这里只管开框与收框。

import { useCallback, useRef, useState } from 'react';
import type { NodeUpgradePending } from './types';

export interface UpgradeConfirmGate {
  pending: NodeUpgradePending | null;
  /** 开框并等结论；已经有一个框开着时直接判否。 */
  ask: (next: NodeUpgradePending) => Promise<boolean>;
  confirm: () => void;
  dismiss: () => void;
}

export function useUpgradeConfirmGate(): UpgradeConfirmGate {
  const [pending, setPending] = useState<NodeUpgradePending | null>(null);
  const settleRef = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback((next: NodeUpgradePending) => {
    if (settleRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      settleRef.current = resolve;
      setPending(next);
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    const resolve = settleRef.current;
    settleRef.current = null;
    setPending(null);
    resolve?.(ok);
  }, []);

  const confirm = useCallback(() => settle(true), [settle]);
  const dismiss = useCallback(() => settle(false), [settle]);

  return { pending, ask, confirm, dismiss };
}
