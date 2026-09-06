// 「发送到另一侧」的提交控制：把两侧面板状态翻成 grant + job 的参数，记住在飞的那一侧与错误码。
//
// 单飞与令牌在 `send-runner.ts`；这里只负责取节点、拼参数，以及把订阅归属绑到弹窗生命周期上
// ——弹窗关掉后才建成的任务只落行，不再由这里起进度流（任务本身照跑，下次打开统一续订）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type DialogNodeOption, findDialogNode } from '../dialog-nodes';
import type { TransferPaneState } from './pane-state';
import { createSendRunner } from './send-runner';
import type { SendSide } from './send-side';
import { sendTransfer } from './send-transfer';

export type { SendSide };

export interface SendController {
  /** 正在提交的那一侧（按钮文案用）；都没有为 null。 */
  sending: SendSide | null;
  /** 任意一侧在飞：两侧按钮都禁用。 */
  busy: boolean;
  errorKey: string | null;
  send: (
    side: SendSide,
    source: TransferPaneState,
    dest: TransferPaneState,
    onSent: () => void
  ) => void;
}

export function useSendTransfer(options: DialogNodeOption[]): SendController {
  const [sending, setSending] = useState<SendSide | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const alive = useRef<AbortSignal | null>(null);

  const runner = useMemo(() => createSendRunner({ setSending, setErrorKey }), []);

  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller.signal;
    return () => {
      controller.abort();
      alive.current = null;
      runner.discard();
    };
  }, [runner]);

  const send = useCallback<SendController['send']>(
    (side, source, dest, onSent) => {
      const sourceNode = findDialogNode(options, source.nodeId);
      const destNode = findDialogNode(options, dest.nodeId);
      if (!sourceNode || !destNode || !source.rootId || !dest.rootId) return;
      const sourceRef = {
        nodeId: sourceNode.id,
        meshId: sourceNode.meshId,
        rootId: source.rootId,
        path: source.path,
        paths: [...source.selection],
      };
      const destRef = {
        nodeId: destNode.id,
        meshId: destNode.meshId,
        rootId: dest.rootId,
        path: dest.path,
      };
      runner.start({
        side,
        onSent,
        run: () =>
          sendTransfer({ source: sourceRef, dest: destRef, signal: alive.current ?? undefined }),
      });
    },
    [options, runner]
  );

  return { sending, busy: sending !== null, errorKey, send };
}
