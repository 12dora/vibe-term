// 节点 ↔ 节点：B 上换 grant，A 上建任务，跟 NDJSON events 直到 end。

import type { CliContext } from './context';
import { CliError, UsageError } from './errors';
import { filesJson, resolveMeshId } from './files-api';
import { consumeNdjson } from './transfer-ndjson';
import { type CopyProgress, pctOf } from './transfer-progress';

export type OnConflict = 'skip' | 'overwrite' | 'rename';

export interface TransferGrant {
  grantId: string;
  token: string;
  expiresAt: number;
}

export interface TransferJobItem {
  relPath: string;
  type?: 'file' | 'dir';
  size: number;
  state: string;
  transferredBytes: number;
  error?: string;
}

export interface TransferProgressDto {
  transferredBytes: number;
  totalBytes: number;
  ratePerSec: number;
  etaSec: number | null;
}

export interface TransferJobSnapshot {
  jobId: string;
  state: string;
  fromNodeId: string;
  toNodeId: string;
  destRootId: string;
  destPath: string;
  expanding: boolean;
  items: TransferJobItem[];
  currentIndex: number;
  progress: TransferProgressDto;
  error?: string;
  errorDetail?: string;
}

export type TransferJobEvent =
  | { type: 'snapshot'; job: TransferJobSnapshot }
  | { type: 'progress'; jobId: string; currentIndex: number; progress: TransferProgressDto }
  | { type: 'item'; jobId: string; index: number; item: TransferJobItem }
  | { type: 'state'; jobId: string; state: string; error?: string; errorDetail?: string }
  | { type: 'end' };

export interface PeerCopyInput {
  sourceNodeId: string;
  destNodeId: string;
  sourceRootId: string;
  destRootId: string;
  items: Array<{ rootId: string; path: string }>;
  destPath: string;
  onConflict: OnConflict;
  progress: CopyProgress;
}

export async function copyPeer(
  ctx: CliContext,
  input: PeerCopyInput
): Promise<TransferJobSnapshot> {
  if (input.onConflict === 'rename') {
    throw new UsageError(
      'node-to-node copy does not support --on-conflict rename',
      'use overwrite or skip'
    );
  }
  const fromMesh = await resolveMeshId(ctx, input.sourceNodeId);
  const toMesh = await resolveMeshId(ctx, input.destNodeId);
  const grant = await filesJson<TransferGrant>(
    ctx.http,
    input.destNodeId,
    'POST',
    '/api/transfer/grants',
    { fromNodeId: fromMesh, destRootId: input.destRootId, destPath: input.destPath }
  );
  const created = await filesJson<{ job: TransferJobSnapshot }>(
    ctx.http,
    input.sourceNodeId,
    'POST',
    '/api/transfer/jobs',
    {
      toNodeId: toMesh,
      items: input.items,
      destRootId: input.destRootId,
      destPath: input.destPath,
      grant: { grantId: grant.grantId, token: grant.token },
      onConflict: input.onConflict,
    }
  );
  return followJob(ctx, input.sourceNodeId, created.job, input.progress);
}

async function followJob(
  ctx: CliContext,
  sourceNodeId: string,
  initial: TransferJobSnapshot,
  progress: CopyProgress
): Promise<TransferJobSnapshot> {
  let snapshot = initial;
  reportSnapshot(progress, snapshot);
  const response = await ctx.http.fetch(
    sourceNodeId,
    `/api/transfer/jobs/${encodeURIComponent(initial.jobId)}/events`,
    { timeoutMs: null }
  );
  await ctx.http.assertOk(sourceNodeId, response, `/api/transfer/jobs/${initial.jobId}/events`);
  await consumeNdjson<TransferJobEvent>(response, (event) => {
    snapshot = applyEvent(snapshot, event);
    if (event.type === 'progress') {
      progress.emit({
        type: 'progress',
        phase: 'transfer',
        bytes: event.progress.transferredBytes,
        total: event.progress.totalBytes,
        pct: pctOf(event.progress.transferredBytes, event.progress.totalBytes),
      });
    } else if (event.type === 'item') {
      progress.emit({ type: 'item', path: event.item.relPath });
    } else if (event.type === 'snapshot') {
      reportSnapshot(progress, event.job);
    }
  });
  if (snapshot.state === 'failed') {
    throw new CliError(snapshot.errorDetail ?? snapshot.error ?? 'transfer job failed');
  }
  if (snapshot.state === 'cancelled') throw new CliError('transfer job cancelled');
  return snapshot;
}

function reportSnapshot(progress: CopyProgress, snapshot: TransferJobSnapshot): void {
  progress.emit({
    type: 'progress',
    phase: 'transfer',
    bytes: snapshot.progress.transferredBytes,
    total: snapshot.progress.totalBytes,
    pct: pctOf(snapshot.progress.transferredBytes, snapshot.progress.totalBytes),
  });
}

function applyEvent(current: TransferJobSnapshot, event: TransferJobEvent): TransferJobSnapshot {
  if (event.type === 'snapshot') return event.job;
  if (event.type === 'progress') {
    return { ...current, currentIndex: event.currentIndex, progress: event.progress };
  }
  if (event.type === 'item') {
    const items = current.items.slice();
    items[event.index] = event.item;
    return { ...current, items };
  }
  if (event.type === 'state') {
    return { ...current, state: event.state, error: event.error, errorDetail: event.errorDetail };
  }
  return current;
}

export async function listTransferJobs(
  ctx: CliContext,
  nodeId: string
): Promise<TransferJobSnapshot[]> {
  const payload = await filesJson<{ jobs?: TransferJobSnapshot[] }>(
    ctx.http,
    nodeId,
    'GET',
    '/api/transfer/jobs'
  );
  return payload.jobs ?? [];
}

export async function cancelTransferJob(
  ctx: CliContext,
  nodeId: string,
  jobId: string
): Promise<void> {
  await filesJson(ctx.http, nodeId, 'DELETE', `/api/transfer/jobs/${encodeURIComponent(jobId)}`);
}
