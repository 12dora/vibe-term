// 节点间文件传输契约（round 32）。任务运行在源节点 A：浏览器先向目标节点 B 申请 grant，
// 再在 A 上创建任务；A 通过 peer 链路（dc / ws-secure / relay 自动选择）把字节推给 B。
// 进度经 `GET /n/<A>/api/transfer/jobs/:id/events`（NDJSON）回到浏览器。

import type { FileErrorCode } from './files';

/** 能力位：随 `SystemInfo.transferCapabilities` 下发，供对端协商是否可用分片并行写入 */
export const TRANSFER_CAPABILITIES = ['transfer-v2', 'transfer-ranged-parallel'] as const;
export type TransferCapability = (typeof TRANSFER_CAPABILITIES)[number];

export type TransferJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type TransferItemState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type TransferErrorCode =
  | FileErrorCode
  | 'node_unreachable'
  | 'grant_invalid'
  | 'grant_expired'
  | 'peer_mismatch'
  | 'offset_mismatch'
  | 'incomplete'
  | 'checksum_mismatch'
  | 'dest_exists'
  /** 同一次任务里两个源文件落到同一个目标相对路径 */
  | 'dest_conflict'
  /** 触到接收侧的会话预算（文件数 / 总字节 / 并发写 / 会话数） */
  | 'limit_exceeded'
  | 'quota_file_size'
  | 'cancelled';

/** 传输路径：与 `files.transfer.pathDirect/pathRelay` 文案对应 */
export type TransferPath = 'direct' | 'relay' | 'local';

export interface TransferProgress {
  transferredBytes: number;
  totalBytes: number;
  /** 最近窗口的字节速率（B/s） */
  ratePerSec: number;
  /** 预计剩余秒数；无法估算时为 null */
  etaSec: number | null;
}

/** 浏览器向目标节点 B 申请的一次性授权 */
export interface TransferGrantRequest {
  /** 源节点 id（将来会以 peer 身份连到 B 的节点） */
  fromNodeId: string;
  destRootId: string;
  /** 目标目录绝对路径（须落在 destRoot 内） */
  destPath: string;
}

export interface TransferGrantResponse {
  grantId: string;
  /** 一次性令牌，只在 A 与 B 建立传输会话时使用 */
  token: string;
  /** 过期时间（epoch ms），默认 10 分钟内必须开始 */
  expiresAt: number;
}

export interface TransferSourceItem {
  rootId: string;
  /** 文件或目录绝对路径（须落在 root 内） */
  path: string;
}

export interface CreateTransferJobRequest {
  toNodeId: string;
  items: TransferSourceItem[];
  destRootId: string;
  destPath: string;
  grant: { grantId: string; token: string };
  /** 目标已存在同名文件时的策略，默认 `skip` */
  onConflict?: 'skip' | 'overwrite';
}

export interface TransferJobItem {
  /** 相对源目录的展示路径（目录展开后为 `dir/sub/file`） */
  relPath: string;
  /** 条目类型，缺省按 `file` 处理；`dir` 只在目标侧建目录，不传字节 */
  type?: 'file' | 'dir';
  size: number;
  state: TransferItemState;
  transferredBytes: number;
  error?: TransferErrorCode;
}

export interface TransferJobSnapshot {
  jobId: string;
  state: TransferJobState;
  fromNodeId: string;
  toNodeId: string;
  destRootId: string;
  destPath: string;
  /** 目录展开完成前 items 只含顶层条目，`expanding` 为 true */
  expanding: boolean;
  items: TransferJobItem[];
  /** 当前正在传输的条目下标（无则 -1） */
  currentIndex: number;
  progress: TransferProgress;
  /** 并行流数（协商后的实际值） */
  streams: number;
  path: TransferPath;
  error?: TransferErrorCode;
  errorDetail?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface CreateTransferJobResponse {
  job: TransferJobSnapshot;
}

export interface ListTransferJobsResponse {
  jobs: TransferJobSnapshot[];
}

/** `GET /api/transfer/jobs/:id/events` NDJSON 事件 */
export type TransferJobEvent =
  | { type: 'snapshot'; job: TransferJobSnapshot }
  | {
      type: 'progress';
      jobId: string;
      currentIndex: number;
      progress: TransferProgress;
      updatedAt: number;
    }
  | { type: 'item'; jobId: string; index: number; item: TransferJobItem }
  | {
      type: 'state';
      jobId: string;
      state: TransferJobState;
      error?: TransferErrorCode;
      errorDetail?: string;
    }
  | { type: 'end' };
