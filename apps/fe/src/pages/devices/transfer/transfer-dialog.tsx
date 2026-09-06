// 文件传输弹窗：左右两个面板各选一个节点 + 目录，选中的条目往另一侧发；下方是传输列表。
//
// 两侧各建自己的 `createNodeApiClient(nodeId)`，不需要 NodeRuntimeScope——列目录只用 REST。

import { useInventoryReadiness } from '@/node/inventory-readiness';
import { useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vibeterm/ui/dialog';
import { useEffect, useMemo, useReducer } from 'react';
import { useTranslation } from 'react-i18next';

import { firstUsableNode, toDialogNodeOptions } from '../dialog-nodes';
import { type SendLabel, sendLabel } from './pane-roots';
import {
  type SendBlock,
  createTransferPaneState,
  sendBlock,
  transferPaneReducer,
} from './pane-state';
import { TransferJobsList } from './transfer-list';
import { TransferPane } from './transfer-pane';
import { useSendTransfer } from './use-send';
import { useTransferJobsSync } from './use-transfer-jobs-sync';

const BLOCK_KEYS: Record<SendBlock, string> = {
  incomplete: 'devices.transfer.pickNodes',
  noSelection: 'devices.transfer.pickSource',
  sameLocation: 'devices.transfer.sameTarget',
};

export interface TransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function TransferDialog({ open, onOpenChange }: TransferDialogProps) {
  const { t } = useTranslation();
  const { meshEnabled, entryNodeId } = useSharedAuthMode();
  const { nodes } = useMeshNodes({ enabled: meshEnabled });
  const selfName = t('device.addTo.self');

  // 成员列表还在同步时不给任何选项：下拉显示「加载中」，而不是把本机列成唯一节点。
  const { loading: nodesLoading } = useInventoryReadiness();
  const options = useMemo(
    () => toDialogNodeOptions(nodes, entryNodeId, selfName, { loading: nodesLoading }),
    [nodes, entryNodeId, selfName, nodesLoading]
  );

  const [left, dispatchLeft] = useReducer(transferPaneReducer, null, () =>
    createTransferPaneState(null)
  );
  const [right, dispatchRight] = useReducer(transferPaneReducer, null, () =>
    createTransferPaneState(null)
  );
  const sender = useSendTransfer(options);

  // 缺省两侧都落到第一个可用节点：多数场景是「本机 → 本机的另一个目录」或「本机 → 某节点」。
  useEffect(() => {
    if (!open) return;
    const fallback = firstUsableNode(options);
    if (!fallback) return;
    if (left.nodeId === null) dispatchLeft({ type: 'selectNode', nodeId: fallback });
    if (right.nodeId === null) dispatchRight({ type: 'selectNode', nodeId: fallback });
  }, [open, options, left.nodeId, right.nodeId]);

  useTransferJobsSync(open, [left.nodeId, right.nodeId]);

  const leftBlock = sendBlock(left, right);
  const rightBlock = sendBlock(right, left);
  const labelOf = (label: SendLabel) =>
    label.node === null ? t(label.key) : t(label.key, { node: label.node });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="devices-transfer-dialog"
        className="flex max-h-[calc(100dvh-2rem)] w-full flex-col sm:max-w-5xl"
      >
        <DialogHeader>
          <DialogTitle>{t('devices.transfer.title')}</DialogTitle>
          <DialogDescription>{t('devices.transfer.description')}</DialogDescription>
        </DialogHeader>

        <div className="-mr-2 flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto pr-2">
          <div className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
            <TransferPane
              side="left"
              state={left}
              dispatch={dispatchLeft}
              nodeOptions={options}
              sendLabel={labelOf(sendLabel(options, right.nodeId, 'devices.transfer.sendToRight'))}
              sendBlockedReason={leftBlock ? t(BLOCK_KEYS[leftBlock]) : null}
              sending={sender.sending === 'left'}
              busy={sender.busy}
              onSend={() =>
                sender.send('left', left, right, () =>
                  // 迟到的成功回调不能清掉「提交之后才勾上的」新选择
                  dispatchLeft({ type: 'clearSelection', revision: left.revision })
                )
              }
            />
            <TransferPane
              side="right"
              state={right}
              dispatch={dispatchRight}
              nodeOptions={options}
              sendLabel={labelOf(sendLabel(options, left.nodeId, 'devices.transfer.sendToLeft'))}
              sendBlockedReason={rightBlock ? t(BLOCK_KEYS[rightBlock]) : null}
              sending={sender.sending === 'right'}
              busy={sender.busy}
              onSend={() =>
                sender.send('right', right, left, () =>
                  dispatchRight({ type: 'clearSelection', revision: right.revision })
                )
              }
            />
          </div>

          {sender.errorKey && (
            <p className="text-xs text-destructive" data-testid="devices-transfer-error">
              {t('devices.transfer.sendFailed')}：{t(sender.errorKey)}
            </p>
          )}

          <TransferJobsList options={options} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
