import type { LinkSession } from '@vibeterm/shared/link';
import { isShareAccessPath } from './auth-public-paths';
import { ForwardDeadlineError, withHttpStreamUploadDeadline } from './forwarder-attempt-deadline';
import { AUTH_SKIP, applyAuthPolicy } from './forwarder-auth-policy';
import { forwardLinkDeadlineFor } from './forwarder-deadline';
import { copyUpstreamHeaders } from './forwarder-headers';
import { rejectClosedLink } from './forwarder-link-state';
import { wrapForwardedBody } from './forwarder-resume';
import type { PeerLinkProvider, PeerLinkPurpose, StreamOpener } from './mesh-deps';

export type ForwardResumeCtx = {
  nodeId: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  origin: string;
  auth: string | null;
  link: LinkSession | null;
  purpose?: PeerLinkPurpose;
  signal?: AbortSignal;
};

export type ResumeDispatchInput = {
  peers: PeerLinkProvider;
  streams: StreamOpener;
  nodeId: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  origin: string;
  auth: string | null;
  purpose?: PeerLinkPurpose;
  signal: AbortSignal;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  log: (line: string) => void;
};

export type OpenHttpOnLinkInput = {
  streams: StreamOpener;
  link: LinkSession;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  origin: string;
  auth: string | null;
  body: ReadableStream<Uint8Array> | null;
  signal: AbortSignal;
  transferMs: number;
};

export function forwardLinkPurpose(path: string): PeerLinkPurpose {
  return path.startsWith('/api/system/') ? 'management' : 'user';
}

export function skipForwardAuth(path: string, method: string): boolean {
  return AUTH_SKIP.has(path) || isShareAccessPath(path, method);
}

export function buildForwardResumeCtx(input: {
  nodeId: string;
  method: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  origin: string;
  auth: string | null;
  purpose?: PeerLinkPurpose;
  signal?: AbortSignal;
}): Omit<ForwardResumeCtx, 'link'> {
  return {
    nodeId: input.nodeId,
    method: input.method,
    path: input.path,
    query: input.query ?? '',
    headers: input.headers,
    origin: input.origin,
    auth: input.auth,
    purpose: input.purpose ?? forwardLinkPurpose(input.path),
    signal: input.signal,
  };
}

/** 首次转发与续传共用：sleep 竞速取链，测试注入的零延时 sleep 不误判超时。 */
export async function acquireForwardLink(opts: {
  pending: Promise<LinkSession>;
  nodeId: string;
  deadlineAt: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  log: (line: string) => void;
  signal?: AbortSignal;
}): Promise<LinkSession> {
  const remaining = opts.deadlineAt - Date.now();
  if (remaining <= 0 || opts.signal?.aborted) throw new ForwardDeadlineError();
  const timeout = new AbortController();
  try {
    const link = await Promise.race([
      opts.pending,
      opts.sleep(remaining, timeout.signal).then(
        () => null,
        () => null
      ),
      abortAsNull(opts.signal),
    ]);
    if (link) return link;
    if (opts.signal?.aborted) throw new ForwardDeadlineError();
    if (Date.now() < opts.deadlineAt) return await opts.pending;
    void opts.pending.catch(() => undefined);
    opts.log(`[mesh] forward link deadline node=${opts.nodeId} waited_ms=${remaining}`);
    throw new ForwardDeadlineError();
  } finally {
    timeout.abort();
  }
}

function abortAsNull(signal?: AbortSignal): Promise<null> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(null), { once: true });
  });
}

/** 已盖章的头 + 当前 live 链路上开 HTTP 流；续传与首次转发共用。 */
export async function openHttpOnLink(input: OpenHttpOnLinkInput): Promise<Response> {
  await rejectClosedLink(input.link);
  return withHttpStreamUploadDeadline(
    input.signal,
    input.transferMs,
    input.headers,
    Boolean(input.body),
    (s) =>
      input.streams.openHttpStream(
        input.link,
        {
          method: input.method,
          path: input.path,
          query: input.query,
          headers: input.headers,
          origin: input.origin,
          auth: input.auth,
        },
        input.body,
        s
      )
  );
}

/** 续传：在当前 live 上重开同一 GET（含取链截止 / 上传墙钟 / 关链拒绝）。 */
export async function dispatchResumeHttp(input: ResumeDispatchInput): Promise<Response> {
  const floorMs = forwardLinkDeadlineFor(
    input.nodeId,
    input.peers.rttOf?.(input.nodeId),
    input.peers
  );
  const purpose = input.purpose ?? forwardLinkPurpose(input.path);
  const link = await acquireForwardLink({
    pending: input.peers.getLink(input.nodeId, { purpose }),
    nodeId: input.nodeId,
    deadlineAt: Date.now() + floorMs,
    sleep: input.sleep,
    log: input.log,
    signal: input.signal,
  });
  return openHttpOnLink({
    streams: input.streams,
    link,
    method: input.method,
    path: input.path,
    query: input.query,
    headers: input.headers,
    origin: input.origin,
    auth: input.auth,
    body: null,
    signal: input.signal,
    transferMs: floorMs,
  });
}

export async function adaptForwardedResponse(
  req: Request,
  upstream: Response,
  ctx: ForwardResumeCtx,
  host: {
    peers: PeerLinkProvider;
    streams: StreamOpener;
    log: (line: string) => void;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    skipAuth: boolean;
  }
): Promise<Response> {
  const headers = copyUpstreamHeaders(upstream);
  const gated = await applyAuthPolicy(req, headers, upstream, ctx.nodeId, host.skipAuth);
  if (gated) return gated;
  const signal = ctx.signal ?? req.signal;
  return wrapForwardedBody({
    req,
    upstream,
    clientHeaders: headers,
    method: ctx.method,
    nodeId: ctx.nodeId,
    path: ctx.path,
    dispatchHeaders: ctx.headers,
    signal,
    log: host.log,
    sleep: host.sleep,
    open: (nextHeaders, nextSignal) =>
      dispatchResumeHttp({
        peers: host.peers,
        streams: host.streams,
        nodeId: ctx.nodeId,
        method: ctx.method,
        path: ctx.path,
        query: ctx.query,
        headers: nextHeaders,
        origin: ctx.origin,
        auth: ctx.auth,
        purpose: ctx.purpose,
        signal: nextSignal,
        sleep: host.sleep,
        log: host.log,
      }),
  });
}
