// 节点间文件传输的 REST 端点。授权（grant）发在目标节点 B，任务发在源节点 A，
// 两侧各自用 `createNodeApiClient(nodeId)` 建的客户端调用，路径本身不带 `/n/<id>` 前缀。

import type {
  CreateTransferJobRequest,
  CreateTransferJobResponse,
  ListTransferJobsResponse,
  TransferGrantRequest,
  TransferGrantResponse,
  TransferJobEvent,
  TransferJobSnapshot,
} from '@vibeterm/shared';
import { type ApiClient, toApiError } from './client';
import { requestJson, requestOk } from './json-mutation';
import { readNdjsonStream } from './ndjson-stream';

export const TRANSFER_GRANTS_PATH = '/api/transfer/grants';
export const TRANSFER_JOBS_PATH = '/api/transfer/jobs';

export function transferJobPath(jobId: string): string {
  return `${TRANSFER_JOBS_PATH}/${encodeURIComponent(jobId)}`;
}

export function transferJobEventsPath(jobId: string): string {
  return `${transferJobPath(jobId)}/events`;
}

function transferError(fallback: string) {
  return (res: Response) => toApiError(res, fallback);
}

/** 在目标节点 B 上换一张一次性授权，随后交给源节点 A 建任务。 */
export function createTransferGrant(
  client: ApiClient,
  body: TransferGrantRequest,
  signal?: AbortSignal
): Promise<TransferGrantResponse> {
  return requestJson<TransferGrantResponse>(client, TRANSFER_GRANTS_PATH, {
    method: 'POST',
    body,
    signal,
    toError: transferError('Failed to create transfer grant'),
  });
}

/** 在源节点 A 上建任务；返回的快照即列表里的第一行。 */
export function createTransferJob(
  client: ApiClient,
  body: CreateTransferJobRequest,
  signal?: AbortSignal
): Promise<TransferJobSnapshot> {
  return requestJson<CreateTransferJobResponse, TransferJobSnapshot>(client, TRANSFER_JOBS_PATH, {
    method: 'POST',
    body,
    signal,
    toError: transferError('Failed to create transfer job'),
    pick: (wire) => wire.job,
  });
}

export function listTransferJobs(
  client: ApiClient,
  signal?: AbortSignal
): Promise<TransferJobSnapshot[]> {
  return requestJson<ListTransferJobsResponse, TransferJobSnapshot[]>(client, TRANSFER_JOBS_PATH, {
    signal,
    toError: transferError('Failed to load transfer jobs'),
    pick: (wire) => wire.jobs,
  });
}

export function getTransferJob(
  client: ApiClient,
  jobId: string,
  signal?: AbortSignal
): Promise<TransferJobSnapshot> {
  return requestJson<CreateTransferJobResponse, TransferJobSnapshot>(
    client,
    transferJobPath(jobId),
    {
      signal,
      toError: transferError('Failed to load transfer job'),
      pick: (wire) => wire.job,
    }
  );
}

export async function cancelTransferJob(client: ApiClient, jobId: string): Promise<void> {
  await requestOk(client, transferJobPath(jobId), {
    method: 'DELETE',
    toError: transferError('Failed to cancel transfer job'),
  });
}

/**
 * 订阅任务进度（NDJSON）。流正常结束或被 `signal` 中止即 resolve；
 * 断流后的重连由调用方（`transfer-jobs-store`）负责，这里不自行重试。
 */
export async function streamTransferJobEvents(
  client: ApiClient,
  jobId: string,
  onEvent: (event: TransferJobEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await requestOk(client, transferJobEventsPath(jobId), {
    signal,
    toError: transferError('Failed to subscribe transfer job'),
  });
  if (!res.body) throw new Error('transfer events stream has no body');
  await readNdjsonStream<TransferJobEvent>(res.body, onEvent);
}
