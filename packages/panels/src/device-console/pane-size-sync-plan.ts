// 远端 pane 尺寸回灌的纯决策：把 resolveRemotePaneSizeSync 的结果翻译成
// effect 直接可执行的动作（要不要清 pending / 要不要 resize / 要不要重拉 history）。
// 不碰 React / DOM / store，所有输入显式传参。

import { type RemotePaneSizeAction, resolveRemotePaneSizeSync } from './pane-selection-rules';

export type PaneSizeSyncPlan =
  | { kind: 'skip' }
  | { kind: 'retry'; delayMs: number }
  | {
      kind: 'apply';
      cols: number;
      rows: number;
      clearPendingLocalSize: boolean;
      resize: boolean;
      /**
       * 远端 resize 后本地 reflow 与 tmux reflow 不保证一致（差一行即让 TUI 的相对移动
       * 重绘永久错位），需重拉 history 以 tmux 权威状态重建本地屏幕；fetch gate 会缓冲
       * 期间的 live 输出保序。只在真正改了尺寸且路由完整时才有意义。
       */
      rebuildHistory: boolean;
    };

export function resolvePaneSizeSyncPlan(
  input: Parameters<typeof resolveRemotePaneSizeSync>[0] & {
    hasPaneRoute: boolean;
    /** false = 本客户端不是整窗 owner：本地上报永远不会被 tmux 回显，pending 不能挡住回灌 */
    owner?: boolean;
  }
): PaneSizeSyncPlan {
  const owner = input.owner ?? true;
  const action: RemotePaneSizeAction = resolveRemotePaneSizeSync(
    owner ? input : { ...input, pendingLocalSize: null }
  );
  if (action.kind !== 'apply') return action;
  return {
    ...action,
    clearPendingLocalSize:
      action.clearPendingLocalSize || (!owner && input.pendingLocalSize != null),
    rebuildHistory: action.resize && input.hasPaneRoute,
  };
}
