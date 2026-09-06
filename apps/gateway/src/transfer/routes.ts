// 浏览器接口：`POST /api/transfer/grants`（在目标节点 B 上签发授权）与
// `/api/transfer/jobs*`（在源节点 A 上建任务、看进度、取消）。
// 走普通节点会话鉴权——浏览器分别持有 A、B 的 cookie，两边各调各的。

import { randomBytes } from 'node:crypto';
import type {
  CreateTransferJobRequest,
  TransferGrantResponse,
  TransferJobEvent,
  TransferSourceItem,
} from '@tmex/shared';
import { ndjsonResponse } from '../api/file-http';
import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, route } from '../api/route';
import { requestDispatchContext } from '../mesh/types';
import { getTransferMeshBridge, streamsForTransport } from './bridge';
import { type TransferChannel, createLocalChannel } from './channel';
import { resolveDestContext } from './dest';
import { createGrant } from './grants';
import {
  type TransferJobRecord,
  cancelJob,
  createJob,
  getJob,
  listJobs,
  subscribeJob,
} from './job-registry';
import { runTransferJob } from './job-runner';
import { createMeshChannel } from './mesh-channel';

const SELF_NODE_ID = 'self';

function uidOf(req: Request): string {
  return requestDispatchContext.get(req)?.uid ?? '';
}

function badRequest(code = 'invalid'): Response {
  return json({ error: code, code }, 400);
}

/** `self` 是浏览器对「入口节点」的写法，服务端一律折算成本机 node id。 */
function normalizeNodeId(raw: unknown, selfNodeId: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw === SELF_NODE_ID) return selfNodeId;
  return /^[0-9a-f]{32}$/.test(raw) ? raw : null;
}

function selfNodeIdOrNull(): string | null {
  return getTransferMeshBridge()?.selfNodeId ?? null;
}

async function handleCreateGrant(req: Request): Promise<Response> {
  const selfNodeId = selfNodeIdOrNull();
  if (!selfNodeId) return json({ error: 'unavailable', code: 'unavailable' }, 503);
  const body = await readJsonObjectBody(req);
  const fromNodeId = normalizeNodeId(body?.fromNodeId, selfNodeId);
  const destRootId = typeof body?.destRootId === 'string' ? body.destRootId : '';
  const destPath = typeof body?.destPath === 'string' ? body.destPath : '';
  if (!fromNodeId || !destRootId || !destPath) return badRequest();
  const dest = resolveDestContext(destRootId, destPath);
  if (!dest.ok) return json({ error: dest.code, code: dest.code }, 400);
  const grant = createGrant({
    fromNodeId,
    destRootId,
    destPath: dest.data.destDir,
    uid: uidOf(req),
  });
  const payload: TransferGrantResponse = {
    grantId: grant.id,
    token: grant.token,
    expiresAt: grant.expiresAt,
  };
  return json(payload);
}

function readItems(raw: unknown): TransferSourceItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: TransferSourceItem[] = [];
  for (const entry of raw) {
    const rootId = (entry as { rootId?: unknown })?.rootId;
    const path = (entry as { path?: unknown })?.path;
    if (typeof rootId !== 'string' || !rootId) return null;
    if (typeof path !== 'string' || !path.startsWith('/')) return null;
    items.push({ rootId, path });
  }
  return items;
}

function pickChannel(
  toNodeId: string,
  selfNodeId: string
): { channel: TransferChannel; streams: number; path: 'direct' | 'relay' | 'local' } {
  if (toNodeId === selfNodeId) {
    return { channel: createLocalChannel(selfNodeId), streams: 1, path: 'local' };
  }
  const transport = getTransferMeshBridge()?.transportOf(toNodeId) ?? null;
  return {
    channel: createMeshChannel(toNodeId),
    streams: streamsForTransport(transport),
    path: transport === 'relay' ? 'relay' : 'direct',
  };
}

async function handleCreateJob(req: Request): Promise<Response> {
  const selfNodeId = selfNodeIdOrNull();
  if (!selfNodeId) return json({ error: 'unavailable', code: 'unavailable' }, 503);
  const body = (await readJsonObjectBody(req)) as (CreateTransferJobRequest & object) | null;
  const toNodeId = normalizeNodeId(body?.toNodeId, selfNodeId);
  const items = readItems(body?.items);
  const destRootId = typeof body?.destRootId === 'string' ? body.destRootId : '';
  const destPath = typeof body?.destPath === 'string' ? body.destPath : '';
  const grant = body?.grant;
  if (!toNodeId || !items || !destRootId || !destPath) return badRequest();
  if (!grant || typeof grant.grantId !== 'string' || typeof grant.token !== 'string') {
    return badRequest('grant_invalid');
  }

  const picked = pickChannel(toNodeId, selfNodeId);
  const job = createJob({
    jobId: randomBytes(12).toString('hex'),
    uid: uidOf(req),
    fromNodeId: selfNodeId,
    toNodeId,
    destRootId,
    destPath,
    path: picked.path,
    streams: picked.streams,
  });
  void runTransferJob({
    job,
    channel: picked.channel,
    grant: { grantId: grant.grantId, token: grant.token },
    items,
    onConflict: body?.onConflict === 'overwrite' ? 'overwrite' : 'skip',
    streams: picked.streams,
  }).catch(() => undefined);
  return json({ job: job.snapshot });
}

function requireJob(req: Request, jobId: string): TransferJobRecord | Response {
  const job = getJob(jobId);
  if (!job || job.uid !== uidOf(req)) return json({ error: 'not_found', code: 'not_found' }, 404);
  return job;
}

/** NDJSON：先补一条 snapshot，再跟增量事件，客户端断开或任务收尾时以 `end` 结束。 */
function handleJobEvents(req: Request, jobId: string): Response {
  const job = requireJob(req, jobId);
  if (job instanceof Response) return job;
  let unsubscribe: (() => void) | null = null;
  return ndjsonResponse({
    start(emit, close) {
      emit({ type: 'snapshot', job: job.snapshot } satisfies TransferJobEvent);
      if (job.snapshot.finishedAt !== null) {
        emit({ type: 'end' } satisfies TransferJobEvent);
        close();
        return;
      }
      unsubscribe = subscribeJob(job, (event) => {
        emit(event);
        if (event.type === 'state' && job.snapshot.finishedAt !== null) {
          emit({ type: 'end' } satisfies TransferJobEvent);
          unsubscribe?.();
          unsubscribe = null;
          close();
        }
      });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
    },
  });
}

export const transferRoutes: ApiRoute[] = [
  route({
    method: 'POST',
    path: '/api/transfer/grants',
    handler: (req) => handleCreateGrant(req),
  }),
  route({
    method: 'POST',
    path: '/api/transfer/jobs',
    handler: (req) => handleCreateJob(req),
  }),
  route({
    method: 'GET',
    path: '/api/transfer/jobs',
    handler: (req) => json({ jobs: listJobs(uidOf(req)) }),
  }),
  route({
    method: 'GET',
    path: '/api/transfer/jobs/:id/events',
    handler: (req, params) => handleJobEvents(req, decodeURIComponent(params.id)),
  }),
  route({
    method: 'GET',
    path: '/api/transfer/jobs/:id',
    handler: (req, params) => {
      const job = requireJob(req, decodeURIComponent(params.id));
      return job instanceof Response ? job : json({ job: job.snapshot });
    },
  }),
  route({
    method: 'DELETE',
    path: '/api/transfer/jobs/:id',
    handler: (req, params) => {
      const jobId = decodeURIComponent(params.id);
      const job = requireJob(req, jobId);
      if (job instanceof Response) return job;
      cancelJob(jobId, uidOf(req));
      return json({ ok: true });
    },
  }),
];
