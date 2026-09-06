// 发起一次节点间传输：先在目标节点换 grant，再在源节点建任务，最后把任务挂进传输 store 并订阅进度。
//
// 顺序不能反：grant 绑定了 fromNodeId / destRootId / destPath，源节点拿着它去连目标节点，
// 目标节点据此确认「这条流确实是浏览器授权过的」。

import { ApiError, createNodeApiClient } from '@tmex/api-client';
import { createTransferGrant, createTransferJob } from '@tmex/api-client';
import { subscribeTransferJob, upsertTransferJobSnapshot } from '@tmex/panels/files/transfers';
import type { TransferErrorCode, TransferJobSnapshot } from '@tmex/shared';

export interface TransferEndpointRef {
  /** 运行时 node id（`self` 或 32 位 hex），用来建 ApiClient。 */
  nodeId: string;
  /** 对端认得的真实 mesh node id。 */
  meshId: string;
  rootId: string;
  path: string;
}

export interface SendTransferParams {
  source: TransferEndpointRef & { paths: string[] };
  dest: TransferEndpointRef;
  onConflict?: 'skip' | 'overwrite';
  /**
   * 发起方（弹窗）的生命周期信号。**不传给请求本身**——关掉弹窗不该取消已经发出的建单，
   * 只用来决定「这次建成的任务还要不要由我来起进度流」：弹窗已经没了就只落行，
   * 下次打开由 `useTransferJobsSync` 统一续订。
   */
  signal?: AbortSignal;
}

export async function sendTransfer(params: SendTransferParams): Promise<TransferJobSnapshot> {
  const { source, dest } = params;
  const destClient = createNodeApiClient(dest.nodeId);
  const sourceClient = createNodeApiClient(source.nodeId);

  const grant = await createTransferGrant(destClient, {
    fromNodeId: source.meshId,
    destRootId: dest.rootId,
    destPath: dest.path,
  });

  const job = await createTransferJob(sourceClient, {
    toNodeId: dest.meshId,
    items: source.paths.map((path) => ({ rootId: source.rootId, path })),
    destRootId: dest.rootId,
    destPath: dest.path,
    grant: { grantId: grant.grantId, token: grant.token },
    onConflict: params.onConflict ?? 'skip',
  });

  upsertTransferJobSnapshot(source.nodeId, job);
  if (!params.signal?.aborted) {
    subscribeTransferJob({ nodeId: source.nodeId, jobId: job.jobId, client: sourceClient });
  }
  return job;
}

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<TransferErrorCode | 'too_many_jobs'>([
  'node_unreachable',
  'grant_invalid',
  'grant_expired',
  'peer_mismatch',
  'offset_mismatch',
  'incomplete',
  'checksum_mismatch',
  'dest_exists',
  'dest_conflict',
  'limit_exceeded',
  'too_many_jobs',
  'quota_file_size',
  'cancelled',
  'not_found',
  'outside_roots',
  'permission_denied',
  'too_large',
  'connection_failed',
  'timeout',
]);

/** 契约错误码 → 文案 key；未知码统一落到 `unknown`。 */
export function transferErrorKey(code: string | null | undefined): string {
  return code && KNOWN_ERROR_CODES.has(code)
    ? `devices.transfer.errors.${code}`
    : 'devices.transfer.errors.unknown';
}

export function transferErrorKeyOf(error: unknown): string {
  return transferErrorKey(error instanceof ApiError ? (error.code ?? error.error) : null);
}
