// 「发送到另一侧」的提交控制：把两侧面板状态翻成 grant + job 的参数，记住在飞的那一侧与错误码。

import { useCallback, useState } from 'react';

import { type DialogNodeOption, findDialogNode } from '../dialog-nodes';
import type { TransferPaneState } from './pane-state';
import { sendTransfer, transferErrorKeyOf } from './send-transfer';

export type SendSide = 'left' | 'right';

export interface SendController {
  sending: SendSide | null;
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

  const send = useCallback(
    (side: SendSide, source: TransferPaneState, dest: TransferPaneState, onSent: () => void) => {
      const sourceNode = findDialogNode(options, source.nodeId);
      const destNode = findDialogNode(options, dest.nodeId);
      if (!sourceNode || !destNode || !source.rootId || !dest.rootId) return;
      setSending(side);
      setErrorKey(null);
      void sendTransfer({
        source: {
          nodeId: sourceNode.id,
          meshId: sourceNode.meshId,
          rootId: source.rootId,
          path: source.path,
          paths: [...source.selection],
        },
        dest: {
          nodeId: destNode.id,
          meshId: destNode.meshId,
          rootId: dest.rootId,
          path: dest.path,
        },
      })
        .then(onSent)
        .catch((error: unknown) => setErrorKey(transferErrorKeyOf(error)))
        .finally(() => setSending(null));
    },
    [options]
  );

  return { sending, errorKey, send };
}
