import type { LinkSession } from '@vibeterm/shared/link';
import {
  armAttemptDeadline,
  waitLinkOrAbort,
  withHttpStreamUploadDeadline,
} from './forwarder-attempt-deadline';
import { cancelForwardBody, countStreamBytes, throttledProgress } from './forwarder-body';
import { forwardLinkDeadlineFor, forwardResponseBudgetMs } from './forwarder-deadline';
import { rejectClosedLink } from './forwarder-link-state';
import { decideForwardAttempt } from './forwarder-pre-dispatch-retry';
import { nodeUnreachableResponse } from './forwarder-unreachable';
import {
  HTTP_FAILOVER_MAX_ATTEMPTS,
  type PeerLinkProvider,
  STREAM_FAILOVER_BACKOFF_MS,
  type StreamOpener,
} from './mesh-deps';

type InternalInput = {
  method?: string;
  query?: string;
  headers?: Record<string, string>;
  rawBody?: ReadableStream<Uint8Array>;
  onProgress?: (uploadedBytes: number) => void;
};

type InternalDeps = {
  peers: PeerLinkProvider;
  streams: StreamOpener;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type InternalForwardJob = {
  deps: InternalDeps;
  nodeId: string;
  path: string;
  body: unknown;
  signal?: AbortSignal;
  input?: InternalInput;
};

type AttemptState = {
  lastError: unknown;
  obtainedLink: boolean;
  link: LinkSession | null;
};

/** JSON 体可重放一次；rawBody 只能读一次。`getLink` 和传输预算都卡在同一次转发截止里。 */
export async function runForwardInternalHttp(job: InternalForwardJob): Promise<Response> {
  const abort = job.signal ?? new AbortController().signal;
  const raw = Boolean(job.input?.rawBody);
  const headers = internalHeaders(job.input, raw);
  const jsonBytes = raw ? null : encodeJson(job.body);
  const floorMs = forwardLinkDeadlineFor(
    job.nodeId,
    job.deps.peers.rttOf?.(job.nodeId),
    job.deps.peers
  );
  const deadlineAt = Date.now() + floorMs;
  const state: AttemptState = { lastError: undefined, obtainedLink: false, link: null };
  const plan = {
    method: (job.input?.method ?? 'POST').toUpperCase(),
    query: job.input?.query ?? '',
    headers,
    raw,
    jsonBytes,
    deadlineAt,
    responseFloorMs: floorMs,
  };
  for (let attempt = 0; attempt < HTTP_FAILOVER_MAX_ATTEMPTS; attempt += 1) {
    if (abort.aborted || Date.now() >= deadlineAt) break;
    const outcome = await runInternalAttempt(job, plan, state, abort, attempt);
    if (outcome instanceof Response) return outcome;
    if (outcome === 'stop') break;
  }
  return nodeUnreachableResponse(
    job.nodeId,
    abort.aborted,
    state.lastError,
    undefined,
    state.obtainedLink
  );
}

type InternalPlan = {
  method: string;
  query: string;
  headers: Record<string, string>;
  raw: boolean;
  jsonBytes: Uint8Array | null;
  deadlineAt: number;
  responseFloorMs: number;
};

async function runInternalAttempt(
  job: InternalForwardJob,
  plan: InternalPlan,
  state: AttemptState,
  abort: AbortSignal,
  attempt: number
): Promise<Response | 'stop' | 'next'> {
  if (attempt > 0 && !(await sleepBackoff(job.deps, abort, attempt))) return 'stop';
  const streamBody = nextInternalBody(job.input, plan.jsonBytes, plan.raw);
  state.link = null;
  state.obtainedLink = false;
  try {
    const linkBudget = Math.max(0, plan.deadlineAt - Date.now());
    state.link = await linkWithin(job.deps, job.nodeId, abort, linkBudget);
    state.obtainedLink = true;
    await rejectClosedLink(state.link);
    return await openInternal(job.deps, state.link, {
      method: plan.method,
      path: job.path,
      query: plan.query,
      headers: plan.headers,
      abort,
      remaining: forwardResponseBudgetMs(plan.deadlineAt - Date.now(), plan.responseFloorMs),
      raw: plan.raw,
      body: streamBody,
    });
  } catch (err) {
    state.lastError = err;
    await cancelForwardBody(streamBody);
    const retry = decideForwardAttempt({
      kind: 'plain',
      method: plan.method,
      attempt,
      err,
      replayable: !plan.raw,
      requestedAttempts: HTTP_FAILOVER_MAX_ATTEMPTS,
      obtainedLink: state.obtainedLink,
      hasRawBody: plan.raw,
      nodeId: job.nodeId,
      link: state.link,
    }).retry;
    if (!retry) return 'stop';
    return 'next';
  }
}

async function sleepBackoff(
  deps: InternalDeps,
  abort: AbortSignal,
  attempt: number
): Promise<boolean> {
  try {
    await deps.sleep(STREAM_FAILOVER_BACKOFF_MS[attempt] ?? 200, abort);
    return true;
  } catch {
    return false;
  }
}

async function linkWithin(
  deps: InternalDeps,
  nodeId: string,
  parent: AbortSignal,
  budgetMs: number
): Promise<LinkSession> {
  const armed = armAttemptDeadline(parent, budgetMs);
  try {
    return await waitLinkOrAbort(deps.peers.getLink(nodeId), armed.signal);
  } finally {
    armed.dispose();
  }
}

function openInternal(
  deps: InternalDeps,
  link: LinkSession,
  open: {
    method: string;
    path: string;
    query: string;
    headers: Record<string, string>;
    abort: AbortSignal;
    remaining: number;
    raw: boolean;
    body: ReadableStream<Uint8Array> | null;
  }
): Promise<Response> {
  return withHttpStreamUploadDeadline(open.abort, open.remaining, open.headers, open.raw, (s) =>
    deps.streams.openHttpStream(
      link,
      {
        method: open.method,
        path: open.path,
        query: open.query,
        headers: open.headers,
        origin: 'http://localhost',
        auth: null,
      },
      open.body,
      s
    )
  );
}

function nextInternalBody(
  input: InternalInput | undefined,
  jsonBytes: Uint8Array | null,
  raw: boolean
): ReadableStream<Uint8Array> | null {
  if (raw && input?.rawBody) {
    let uploaded = 0;
    const progress = input.onProgress ? throttledProgress(input.onProgress) : null;
    return countStreamBytes(input.rawBody, (n) => {
      uploaded += n;
      progress?.(uploaded);
    });
  }
  if (!jsonBytes) return null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (jsonBytes.byteLength > 0) controller.enqueue(jsonBytes);
      controller.close();
    },
  });
}

function internalHeaders(input: InternalInput | undefined, raw: boolean): Record<string, string> {
  const headers: Record<string, string> = { ...(input?.headers ?? {}) };
  if (!raw) headers['content-type'] = headers['content-type'] ?? 'application/json';
  return headers;
}

function encodeJson(body: unknown): Uint8Array {
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return new TextEncoder().encode(payload);
}
