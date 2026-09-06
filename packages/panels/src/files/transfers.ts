// 传输 store 的独立入口（`@tmex/panels/files/transfers`）。
//
// 与 `./index` 分开是有意的：`@tmex/panels/files` 在若干单测里被 `mock.module` 整体替换，
// store 跟着一起消失；弹窗与 store 的消费方走这个只含 store 的子路径，不受那些替身影响。

export {
  BROWSER_ENDPOINT_ID,
  TRANSFER_JOB_GONE,
  applyTransferJobEvent,
  cancelTransferJobEntry,
  clearFinishedTransferJobs,
  combineLegPct,
  createRateEstimator,
  getTransferJobView,
  getTransferJobsSnapshot,
  isTerminalTransferState,
  putTransferJobView,
  reduceTransferEvent,
  registerTransferCancel,
  removeTransferJob,
  resetTransferJobsForTest,
  settleMissingTransferJob,
  startLocalTransfer,
  subscribeTransferJobsStore,
  transferJobKey,
  transferPct,
  upsertTransferJobSnapshot,
  useTransferJobs,
  viewFromSnapshot,
} from './transfer-jobs-store';
export type {
  LocalTransferHandle,
  LocalTransferOptions,
  RateEstimator,
  TransferEntryKind,
  TransferJobView,
} from './transfer-jobs-store';
export {
  TRANSFER_RECONNECT_BACKOFF_MS,
  dropTransferJob,
  stopAllTransferSubscriptions,
  subscribeTransferJob,
} from './transfer-job-stream';
export type { TransferSubscribeOptions } from './transfer-job-stream';
