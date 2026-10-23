// 传输进度 Toast。每个批（单个文件也是只有一个条目的批）对应一张 sonner 卡片和一行
// `transfer-jobs-store` 条目，设备页的传输弹窗读的就是同一份列表。
// 卡片本身只是 `BatchProgress` 的渲染器：进度数字全部来自 `progress.view()`。

import type { LegProgress } from '@vibeterm/api-client';
import type { TransferProgress } from '@vibeterm/shared';
import i18next from 'i18next';
import { toast } from 'sonner';
import type { TransferPath } from './bulk-transfer';
import type { BatchFinish } from './transfer-batch';
import {
  type LocalTransferHandle,
  createRateEstimator,
  startLocalTransfer,
} from './transfer-jobs-store';
import {
  BatchProgress,
  type BatchView,
  type LegWeights,
  type TransferDirection,
} from './transfer-progress';
import { ToastBody } from './transfer-toast-view';

export type { TransferDirection } from './transfer-progress';

/** 本次传输实际走的通道（与 `bulk-transfer.ts` 的 `TransferPath` 同义）。 */
export type TransferToastPath = TransferPath;

/** 工作态的重绘间隔下限；状态切换不受限。 */
const RENDER_INTERVAL_MS = 100;

export interface BatchToastOptions {
  progress: BatchProgress;
  /** 单个文件为文件名，批量为批标题。 */
  title: string;
  /** 另一端的节点（`self` 或 32 位 hex）；不传则只出 Toast、列表里不留行。 */
  nodeId?: string;
  onCancel: () => void;
}

export interface BatchToast {
  /** 进度或状态有变化；`immediate` 跳过节流。 */
  notify: (immediate: boolean) => void;
  finish: (result: BatchFinish) => void;
}

function toastId(title: string): string {
  return `transfer-${title}-${performance.now()}`;
}

function openRow(options: BatchToastOptions, id: string): LocalTransferHandle | null {
  const { progress, nodeId } = options;
  if (nodeId === undefined) return null;
  const view = progress.view();
  return startLocalTransfer({
    id,
    kind: progress.direction,
    title: options.title,
    nodeId,
    totalBytes: view.totalBytes,
    itemsTotal: view.itemsTotal,
    onCancel: options.onCancel,
  });
}

function pushRow(row: LocalTransferHandle | null, view: BatchView, net: TransferProgress): void {
  row?.update({
    pct: view.pct,
    progress: {
      transferredBytes: view.transferredBytes,
      totalBytes: view.totalBytes,
      ratePerSec: net.ratePerSec,
      etaSec: net.etaSec,
    },
    itemsDone: view.itemsDone,
    itemsTotal: view.itemsTotal,
  });
}

// 启动批的进度 Toast，复用 app 统一的 sonner 卡片样式。
// 工作态：duration:Infinity + dismissible:false + closeButton:false（不自动消失/不可手动关闭，
// 仅取消按钮可终止）。完成 success 卡片（短暂后消失）；失败 error 卡片（保留可关闭）；取消直接收起。
export function startBatchToast(options: BatchToastOptions): BatchToast {
  const { progress, title, onCancel } = options;
  const id = toastId(title);
  const row = openRow(options, id);
  let rowPath: TransferPath | null = null;
  const estimator = createRateEstimator();
  let lastRender = Number.NEGATIVE_INFINITY;

  // 速率只看网络那一段，用真实字节差分；与进度条（两段合成）无关
  const flush = (): { view: BatchView; ratePerSec: number } => {
    const now = performance.now();
    lastRender = now;
    const view = progress.view();
    const net = estimator.sample(view.networkBytes, view.totalBytes, now);
    pushRow(row, view, net);
    if (view.path && view.path !== rowPath) {
      rowPath = view.path;
      row?.setPath(view.path);
    }
    return { view, ratePerSec: net.ratePerSec };
  };

  const renderWorking = () => {
    const { view, ratePerSec } = flush();
    toast(<ToastBody model={{ title, view, ratePerSec }} t={i18next.t} />, {
      id,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
      closeButton: false,
      // 取消用 sonner 的 action 按钮（位于卡片右侧区域）。注意：sonner 的 cancel 按钮在
      // dismissible:false 时会被禁用（源码 `if (!dismissible) return`），故必须用 action。
      action: { label: i18next.t('files.transfer.cancel'), onClick: () => onCancel() },
      // sonner 的 content 默认按内容宽度收缩 → 进度条不满；flex-1 让内容占满可用区域（取消按钮之外）
      classNames: { content: 'flex-1' },
    });
  };
  renderWorking();

  const finishRow = (result: BatchFinish) => {
    const view = progress.view();
    pushRow(row, view, estimator.sample(view.networkBytes, view.totalBytes, performance.now()));
    if (result.kind === 'success') row?.done();
    else if (result.kind === 'failure') row?.fail();
    else row?.cancelled();
  };

  return {
    notify(immediate) {
      if (!immediate && performance.now() - lastRender < RENDER_INTERVAL_MS) return;
      renderWorking();
    },
    finish(result) {
      finishRow(result);
      if (result.kind === 'cancel') {
        toast.dismiss(id);
      } else if (result.kind === 'success') {
        toast.success(<span data-testid="transfer-toast">{result.message}</span>, {
          id,
          duration: 4000,
          dismissible: true,
          closeButton: true,
        });
      } else {
        toast.error(<span data-testid="transfer-toast">{result.message}</span>, {
          id,
          description: result.description,
          duration: Number.POSITIVE_INFINITY,
          dismissible: true,
          closeButton: true,
          classNames: { description: 'whitespace-pre-line' },
        });
      }
    },
  };
}

/** 登记到传输列表所需的上下文；不传则只出 Toast（列表里不留行）。 */
export interface TransferToastEntry {
  /** 另一端的节点 id（`self` 或 32 位 hex）。 */
  nodeId: string;
  /** 已知总字节数；未知时列表只显示百分比。 */
  totalBytes?: number;
}

/** 单个文件的命令式句柄：由传输函数的回调推进。 */
export interface TransferToast {
  leg: (n: 1 | 2, p: LegProgress) => void;
  legWeights: (weights: LegWeights) => void;
  /** 传输路径确定后调用，在文件名旁显示 direct / relay 徽标。 */
  setPath: (path: TransferToastPath) => void;
  success: (message: string) => void;
  /** `description` 放具体原因，见 `describeTransferError`。 */
  fail: (message: string, description?: string) => void;
  cancel: () => void;
}

export function startTransferToast(
  fileName: string,
  direction: TransferDirection,
  onCancel: () => void,
  entry?: TransferToastEntry
): TransferToast {
  const progress = new BatchProgress(direction, [{ name: fileName, size: entry?.totalBytes ?? 0 }]);
  progress.setStatus(0, 'running');
  const batch = startBatchToast({ progress, title: fileName, nodeId: entry?.nodeId, onCancel });
  const settle = (status: 'done' | 'failed' | 'cancelled', result: BatchFinish) => {
    progress.setStatus(0, status);
    batch.finish(result);
  };
  return {
    leg(n, p) {
      progress.leg(0, n, p);
      batch.notify(p.pct >= 100);
    },
    legWeights(weights) {
      progress.weights(0, weights);
      batch.notify(false);
    },
    setPath(path) {
      progress.setPath(path);
      batch.notify(true);
    },
    success: (message) => settle('done', { kind: 'success', message }),
    fail: (message, description) => settle('failed', { kind: 'failure', message, description }),
    cancel: () => settle('cancelled', { kind: 'cancel' }),
  };
}
