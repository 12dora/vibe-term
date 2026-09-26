import type { NodeUnreachableReason } from '@vibeterm/shared';
import type { LinkSession } from '@vibeterm/shared/link';
import { ForwardDeadlineError } from './forwarder-attempt-deadline';
import {
  classifyUnreachableReason,
  isPendingMeasureRefusal,
  isPreDispatchTransportRefusal,
} from './forwarder-unreachable';
import { HTTP_FAILOVER_MAX_ATTEMPTS } from './mesh-deps';
import { emitTransportRefused, transportOfLink } from './pending-measure-hold';

export type ForwardAttemptKind = 'plain' | 'authorized';

export type ForwardAttemptInput = {
  kind: ForwardAttemptKind;
  method: string;
  attempt: number;
  err: unknown;
  replayable: boolean;
  requestedAttempts: number;
  obtainedLink: boolean;
  hasRawBody?: boolean;
  nodeId?: string;
  link?: LinkSession | null;
};

/** 三条转发入口共用：要不要再试，以及这次失败该告诉浏览器的 reason。 */
export function decideForwardAttempt(input: ForwardAttemptInput): {
  retry: boolean;
  reason: NodeUnreachableReason;
} {
  if (input.nodeId) noteRefusal(input.nodeId, input.link ?? null, input.err);
  return {
    retry: retryForwardFailure(input),
    reason: classifyUnreachableReason(false, input.err, input.obtainedLink),
  };
}

/** 小请求先缓冲再发，pending-measure 这种开流即拒才能安全重放 POST。 */
export const REPLAY_BODY_LIMIT = 64 * 1024;

export type ReplayableBody = {
  canReplay: boolean;
  hasBody: boolean;
  next(): ReadableStream<Uint8Array> | null;
};

const NO_BODY_METHOD = new Set(['GET', 'HEAD']);

export function captureLink<T>(pending: Promise<T>, box: { current: T | null }): Promise<T> {
  return pending.then((value) => {
    box.current = value;
    return value;
  });
}

/** 只缓冲声明了 content-length 且不超限的请求体；流式上传（无长度/可能永不结束）原样透传。 */
export async function bufferReplayableBody(req: Request): Promise<ReplayableBody> {
  if (NO_BODY_METHOD.has(req.method) || !req.body) return emptyBody();
  const declared = declaredLength(req);
  if (declared === null || declared > REPLAY_BODY_LIMIT) return onceStream(req.body);
  const read = await readBounded(req.body, REPLAY_BODY_LIMIT);
  if (read.kind === 'overflow') return onceStream(read.stream);
  return replayBytes(read.bytes);
}

export function noteAndContinuePlainHttp(input: {
  method: string;
  attempt: number;
  err: unknown;
  canReplay: boolean;
  nodeId: string;
  link: LinkSession | null;
}): boolean {
  return decideForwardAttempt({
    kind: 'plain',
    method: input.method,
    attempt: input.attempt,
    err: input.err,
    replayable: input.canReplay,
    requestedAttempts: HTTP_FAILOVER_MAX_ATTEMPTS,
    obtainedLink: Boolean(input.link),
    nodeId: input.nodeId,
    link: input.link,
  }).retry;
}

export function warnRawAbort(nodeId: string, uploaded: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[mesh][forward] raw-body push aborted node=${nodeId} bytes=${uploaded} err=${message}`
  );
}

export function shouldRetryAuthorized(
  err: unknown,
  attempt: number,
  attempts: number,
  rawBody: ReadableStream<Uint8Array> | null,
  meta: { method: string; nodeId: string; link: LinkSession | null }
): boolean {
  return noteAndContinueAuthorized({
    method: meta.method,
    attempt,
    err,
    hasRawBody: Boolean(rawBody),
    attempts,
    nodeId: meta.nodeId,
    link: meta.link,
  });
}

export function noteAndContinueAuthorized(input: {
  method: string;
  attempt: number;
  err: unknown;
  hasRawBody: boolean;
  attempts: number;
  nodeId: string;
  link: LinkSession | null;
}): boolean {
  return decideForwardAttempt({
    kind: 'authorized',
    method: input.method,
    attempt: input.attempt,
    err: input.err,
    replayable: true,
    requestedAttempts: input.attempts,
    obtainedLink: Boolean(input.link),
    hasRawBody: input.hasRawBody,
    nodeId: input.nodeId,
    link: input.link,
  }).retry;
}

function retryForwardFailure(input: ForwardAttemptInput): boolean {
  if (input.hasRawBody || input.err instanceof ForwardDeadlineError) return false;
  if (input.kind === 'authorized') return retryAuthorized(input);
  if (NO_BODY_METHOD.has(input.method)) return input.attempt + 1 < input.requestedAttempts;
  return input.attempt === 0 && input.replayable && isPreDispatchTransportRefusal(input.err);
}

function retryAuthorized(input: ForwardAttemptInput): boolean {
  if (input.attempt + 1 < input.requestedAttempts) return true;
  if (NO_BODY_METHOD.has(input.method) || input.requestedAttempts !== 1) return false;
  return input.attempt === 0 && isPreDispatchTransportRefusal(input.err);
}

function noteRefusal(nodeId: string, link: LinkSession | null, err: unknown): void {
  if (!directPendingMeasure(link, err)) return;
  emitTransportRefused(nodeId, link);
}

/** 只有直连上的 pending-measure 隔离整节点。stale-link / parked 仍可重放，但不隔离。 */
function directPendingMeasure(link: LinkSession | null, err: unknown): boolean {
  if (!link || !isPendingMeasureRefusal(err)) return false;
  const transport = transportOfLink(link);
  return transport === 'dc' || transport === 'ws-secure';
}

function declaredLength(req: Request): number | null {
  const raw = req.headers.get('content-length');
  if (raw === null) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function emptyBody(): ReplayableBody {
  return { canReplay: true, hasBody: false, next: () => null };
}

function replayBytes(bytes: Uint8Array): ReplayableBody {
  return {
    canReplay: true,
    hasBody: bytes.byteLength > 0,
    next: () => streamOf(bytes),
  };
}

function onceStream(stream: ReadableStream<Uint8Array>): ReplayableBody {
  let used = false;
  return {
    canReplay: false,
    hasBody: true,
    next() {
      if (used) return null;
      used = true;
      return stream;
    },
  };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

type BoundedRead =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'overflow'; stream: ReadableStream<Uint8Array> };

async function readBounded(body: ReadableStream<Uint8Array>, limit: number): Promise<BoundedRead> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) return { kind: 'bytes', bytes: concatChunks(chunks, total) };
    const overflow = overflowRead(chunks, total, step.value, reader, limit);
    if (overflow) return overflow;
    if (!step.value || step.value.byteLength === 0) continue;
    chunks.push(step.value);
    total += step.value.byteLength;
  }
}

function overflowRead(
  chunks: Uint8Array[],
  total: number,
  value: Uint8Array | undefined,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number
): BoundedRead | null {
  if (!value || total + value.byteLength <= limit) return null;
  const head = concatChunks(chunks, total);
  return { kind: 'overflow', stream: stitchUnread(head, value, reader) };
}

function stitchUnread(
  head: Uint8Array,
  extra: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>
): ReadableStream<Uint8Array> {
  const prefix = [head, extra];
  return new ReadableStream({
    async pull(controller) {
      const next = prefix.shift();
      if (next) {
        if (next.byteLength > 0) controller.enqueue(next);
        return;
      }
      const step = await reader.read();
      if (step.done) {
        controller.close();
        return;
      }
      if (step.value && step.value.byteLength > 0) controller.enqueue(step.value);
    },
    cancel() {
      void reader.cancel().catch(() => undefined);
    },
  });
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
