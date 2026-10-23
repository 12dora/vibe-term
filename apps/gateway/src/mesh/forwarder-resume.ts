import { type ResumePlan, parseContentRange, resumePlanFrom } from './http-resume-plan';

export {
  ENTITY_LENGTH_HEADER,
  parseContentRange,
  resumePlanFrom,
  type ResumePlan,
  type ResumeValidator,
} from './http-resume-plan';

export const RESUME_BACKOFF_MS = [250, 500, 1000, 2000] as const;
export const RESUME_EMPTY_LIMIT = 4;

export type ResumeOpen = (
  headers: Record<string, string>,
  signal: AbortSignal
) => Promise<Response>;

export type WrapForwardInput = {
  req: Request;
  upstream: Response;
  clientHeaders: Headers;
  method: string;
  nodeId: string;
  path: string;
  dispatchHeaders: Record<string, string>;
  signal: AbortSignal;
  log: (line: string) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  open: ResumeOpen;
};

type ResumeHost = {
  plan: ResumePlan;
  signal: AbortSignal;
  nodeId: string;
  path: string;
  dispatchHeaders: Record<string, string>;
  log: (line: string) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  open: ResumeOpen;
};

type ResumePump = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  relayed: number;
  emptyFails: number;
  gotFromCurrent: boolean;
  done: boolean;
  failed: boolean;
  cancelled: boolean;
  attempt: AbortController | null;
  attemptUnsub: (() => void) | null;
};

type ReadStep =
  | { kind: 'data'; bytes: Uint8Array }
  | { kind: 'end' }
  | { kind: 'error'; err: unknown };

export function continuationHeaders(
  base: Record<string, string>,
  plan: ResumePlan,
  relayed: number
): Record<string, string> {
  const headers = { ...base };
  writeHeader(headers, 'Range', `bytes=${plan.start + relayed}-${plan.end}`);
  writeHeader(headers, 'If-Range', plan.validator.value);
  return headers;
}

export function verifyContinuation(
  response: Response,
  plan: ResumePlan,
  expectedStart: number
): boolean {
  if (response.status !== 206) return false;
  const range = parseContentRange(response.headers.get('content-range'));
  if (!range) return false;
  if (range.start !== expectedStart || range.end !== plan.end || range.total !== plan.total) {
    return false;
  }
  const value = response.headers.get(plan.validator.header)?.trim() ?? '';
  return value === plan.validator.value;
}

export function wrapForwardedBody(input: WrapForwardInput): Response {
  const { upstream, clientHeaders } = input;
  const body = upstream.body;
  if (!body) return new Response(null, { status: upstream.status, headers: clientHeaders });
  const plan = resumePlanFrom(input.method, upstream.status, upstream.headers);
  if (!plan) {
    return new Response(body, { status: upstream.status, headers: clientHeaders });
  }
  return new Response(resumableBody(body, plan, input), {
    status: upstream.status,
    headers: clientHeaders,
  });
}

function writeHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
  headers[name] = value;
}

function resumableBody(
  initial: ReadableStream<Uint8Array>,
  plan: ResumePlan,
  input: WrapForwardInput
): ReadableStream<Uint8Array> {
  const host: ResumeHost = {
    plan,
    signal: input.signal,
    nodeId: input.nodeId,
    path: input.path,
    dispatchHeaders: input.dispatchHeaders,
    log: input.log,
    sleep: input.sleep,
    open: input.open,
  };
  const pump: ResumePump = {
    reader: initial.getReader(),
    relayed: 0,
    emptyFails: 0,
    gotFromCurrent: true,
    done: false,
    failed: false,
    cancelled: false,
    attempt: null,
    attemptUnsub: null,
  };
  const expected = plan.end - plan.start + 1;
  return new ReadableStream({
    pull: (controller) => pullResumable(pump, host, controller, expected),
    cancel() {
      pump.cancelled = true;
      pump.attempt?.abort();
      detachAttempt(pump);
      void pump.reader.cancel().catch(() => undefined);
    },
  });
}

async function pullResumable(
  pump: ResumePump,
  host: ResumeHost,
  controller: ReadableStreamDefaultController<Uint8Array>,
  expected: number
): Promise<void> {
  if (pumpClosed(pump)) return;
  while (true) {
    if (stopped(pump, host)) return failPump(pump, controller, abortErr(host));
    const step = await readStep(pump);
    if (step.kind === 'data') {
      if (enqueueSlice(pump, controller, step.bytes, expected)) return;
      continue;
    }
    if (closeIfComplete(pump, controller, step, expected)) return;
    if (!pump.gotFromCurrent) pump.emptyFails += 1;
    if (stopped(pump, host)) return failPump(pump, controller, abortErr(host));
    const next = await resumeAfterLoss(pump, host);
    if (next === 'ok') continue;
    failPump(pump, controller, outcomeErr(next, host, step, pump, expected));
    return;
  }
}

function pumpClosed(pump: ResumePump): boolean {
  return pump.done || pump.failed;
}

function closeIfComplete(
  pump: ResumePump,
  controller: ReadableStreamDefaultController<Uint8Array>,
  step: ReadStep,
  expected: number
): boolean {
  if (step.kind !== 'end' || pump.relayed < expected) return false;
  pump.done = true;
  controller.close();
  return true;
}

function outcomeErr(
  next: 'abort' | 'fail',
  host: ResumeHost,
  step: ReadStep,
  pump: ResumePump,
  expected: number
): unknown {
  if (next === 'abort') return abortErr(host);
  return resumeFailErr(step, pump, expected);
}

function enqueueSlice(
  pump: ResumePump,
  controller: ReadableStreamDefaultController<Uint8Array>,
  bytes: Uint8Array,
  expected: number
): boolean {
  if (bytes.byteLength === 0) return false;
  const room = expected - pump.relayed;
  const chunk = bytes.byteLength > room ? bytes.subarray(0, room) : bytes;
  if (chunk.byteLength === 0) {
    pump.done = true;
    controller.close();
    return true;
  }
  if (!pump.gotFromCurrent) {
    pump.emptyFails = 0;
    pump.gotFromCurrent = true;
  }
  pump.relayed += chunk.byteLength;
  controller.enqueue(chunk);
  if (pump.relayed >= expected) {
    pump.done = true;
    controller.close();
    void pump.reader.cancel().catch(() => undefined);
  }
  return true;
}

async function resumeAfterLoss(
  pump: ResumePump,
  host: ResumeHost
): Promise<'ok' | 'abort' | 'fail'> {
  while (pump.emptyFails < RESUME_EMPTY_LIMIT) {
    if (stopped(pump, host)) return 'abort';
    const signal = attachAttempt(pump, host);
    try {
      await host.sleep(RESUME_BACKOFF_MS[pump.emptyFails] ?? 2000, signal);
    } catch {
      return stopped(pump, host) ? 'abort' : 'fail';
    }
    if (stopped(pump, host)) return 'abort';
    const offset = host.plan.start + pump.relayed;
    logResume(host, offset, pump.emptyFails + 1);
    const opened = await openContinuation(pump, host, offset, signal);
    if (opened === 'ok') return 'ok';
    if (opened === 'abort') return 'abort';
    if (opened === 'reject') return 'fail';
    pump.emptyFails += 1;
  }
  return 'fail';
}

async function openContinuation(
  pump: ResumePump,
  host: ResumeHost,
  offset: number,
  signal: AbortSignal
): Promise<'ok' | 'abort' | 'reject' | 'empty'> {
  try {
    const response = await host.open(
      continuationHeaders(host.dispatchHeaders, host.plan, pump.relayed),
      signal
    );
    if (stopped(pump, host)) {
      void response.body?.cancel().catch(() => undefined);
      return 'abort';
    }
    if (!verifyContinuation(response, host.plan, offset)) {
      void response.body?.cancel().catch(() => undefined);
      return 'reject';
    }
    if (!response.body) return 'empty';
    void pump.reader.cancel().catch(() => undefined);
    pump.reader = response.body.getReader();
    pump.gotFromCurrent = false;
    return 'ok';
  } catch {
    // 取链/开流超时不是客户端 abort，算一次零进度续传。
    return stopped(pump, host) ? 'abort' : 'empty';
  }
}

function detachAttempt(pump: ResumePump): void {
  pump.attemptUnsub?.();
  pump.attemptUnsub = null;
}

function attachAttempt(pump: ResumePump, host: ResumeHost): AbortSignal {
  detachAttempt(pump);
  const ctrl = new AbortController();
  pump.attempt = ctrl;
  const parent = host.signal;
  if (parent.aborted || pump.cancelled) {
    ctrl.abort();
    return ctrl.signal;
  }
  const onAbort = (): void => ctrl.abort();
  parent.addEventListener('abort', onAbort);
  pump.attemptUnsub = () => parent.removeEventListener('abort', onAbort);
  return ctrl.signal;
}

function readStep(pump: ResumePump): Promise<ReadStep> {
  return pump.reader.read().then(decodeStep, (err: unknown) => ({ kind: 'error', err }));
}

function decodeStep(step: { done: boolean; value?: Uint8Array }): ReadStep {
  if (step.done) return { kind: 'end' };
  return { kind: 'data', bytes: step.value ?? new Uint8Array() };
}

function logResume(host: ResumeHost, offset: number, attempt: number): void {
  const path = host.path.split('?')[0] ?? host.path;
  const peer = host.nodeId.slice(0, 8);
  host.log(`[mesh][fwd] resume peer=${peer} path=${path} offset=${offset} attempt=${attempt}`);
}

function stopped(pump: ResumePump, host: ResumeHost): boolean {
  return pump.cancelled || host.signal.aborted;
}

function failPump(
  pump: ResumePump,
  controller: ReadableStreamDefaultController<Uint8Array>,
  err: unknown
): void {
  pump.failed = true;
  pump.attempt?.abort();
  detachAttempt(pump);
  void pump.reader.cancel().catch(() => undefined);
  try {
    controller.error(err instanceof Error ? err : new Error(String(err)));
  } catch {
    // already closed
  }
}

function resumeFailErr(step: ReadStep, pump: ResumePump, expected: number): unknown {
  if (step.kind === 'error') return step.err;
  return new Error(`http body truncated: sent=${pump.relayed} expected=${expected}`);
}

function abortErr(host: ResumeHost): Error {
  const reason = host.signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}
