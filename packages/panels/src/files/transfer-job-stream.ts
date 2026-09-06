// 节点任务的 NDJSON 订阅：一条流对应 store 里的一行，断流后重新拉快照再续订，
// 状态到达终态（完成 / 失败 / 已取消）或任务已被回收（404）即停。

import {
  type ApiClient,
  ApiError,
  cancelTransferJob,
  getTransferJob as fetchTransferJob,
  streamTransferJobEvents,
} from '@tmex/api-client';
import {
  applyTransferJobEvent,
  getTransferJobView,
  isTerminalTransferState,
  registerTransferCancel,
  removeTransferJob,
  settleMissingTransferJob,
  transferJobKey,
  upsertTransferJobSnapshot,
} from './transfer-jobs-store';

/** 断流重连的退避阶梯（毫秒），与升级推包同型。 */
export const TRANSFER_RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const;

export interface TransferSubscribeOptions {
  nodeId: string;
  jobId: string;
  client: ApiClient;
  backoffMs?: readonly number[];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** 源节点上已经没有这个任务（重启后内存注册表清空）：两个端点都会 404。 */
function isJobGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** 拉一次快照收敛状态；任务已终态或已不存在返回 true（订阅可以收工）。 */
async function refreshSnapshot(
  options: TransferSubscribeOptions,
  signal: AbortSignal
): Promise<boolean> {
  try {
    const job = await fetchTransferJob(options.client, options.jobId, signal);
    upsertTransferJobSnapshot(options.nodeId, job);
    return isTerminalTransferState(job.state);
  } catch (error) {
    if (signal.aborted) return true;
    if (isJobGone(error)) {
      settleMissingTransferJob(options.nodeId, options.jobId);
      return true;
    }
    // 任务已被源节点回收：本地行也没有再刷新的意义
    const view = getTransferJobView(transferJobKey(options.nodeId, options.jobId));
    return view === undefined || isTerminalTransferState(view.state);
  }
}

async function runSubscription(
  options: TransferSubscribeOptions,
  signal: AbortSignal
): Promise<void> {
  const backoff = options.backoffMs ?? TRANSFER_RECONNECT_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;

  while (!signal.aborted) {
    try {
      await streamTransferJobEvents(
        options.client,
        options.jobId,
        (event) => applyTransferJobEvent(options.nodeId, options.jobId, event),
        signal
      );
      attempt = 0;
    } catch (error) {
      // 404 是「任务不存在」，重连没有意义：直接把行落到终态收工；其余断流交给下面的快照定夺
      if (!signal.aborted && isJobGone(error)) {
        settleMissingTransferJob(options.nodeId, options.jobId);
        return;
      }
    }
    if (signal.aborted) return;
    if (await refreshSnapshot(options, signal)) return;
    if (signal.aborted) return;
    await sleep(backoff[Math.min(attempt, backoff.length - 1)], signal);
    attempt += 1;
  }
}

const active = new Map<string, () => void>();

/**
 * 订阅一条任务；同一 (nodeId, jobId) 重复调用复用已有订阅。
 * 返回停止函数——弹窗关闭时逐个调用即可，正在跑的任务下次打开会重新订阅。
 */
export function subscribeTransferJob(options: TransferSubscribeOptions): () => void {
  const key = transferJobKey(options.nodeId, options.jobId);
  const existing = active.get(key);
  if (existing) return existing;

  const controller = new AbortController();
  const stop = () => {
    if (active.get(key) === stop) active.delete(key);
    controller.abort();
  };
  active.set(key, stop);
  registerTransferCancel(key, () => {
    void cancelTransferJob(options.client, options.jobId).catch(() => undefined);
  });

  void runSubscription(options, controller.signal).finally(() => {
    if (active.get(key) === stop) active.delete(key);
  });
  return stop;
}

export function stopAllTransferSubscriptions(): void {
  for (const stop of [...active.values()]) stop();
}

/** 列表里手动移除一行：先停订阅再删行。 */
export function dropTransferJob(nodeId: string, jobId: string): void {
  const key = transferJobKey(nodeId, jobId);
  active.get(key)?.();
  removeTransferJob(key);
}
