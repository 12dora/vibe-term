import type { LinkStream, StreamChunk } from '@vibeterm/shared/link';
import { parseContentLengthHeader } from './forwarder-attempt-deadline';
import type { HttpHeadResult } from './stream-http-head';

const HTTP_FORWARD_ABORT_LOG_INTERVAL_MS = 1_000;
let lastHttpForwardAbortLogAt = 0;

type HttpBodyState = {
  sent: number;
  failed: boolean;
  aborted: boolean;
  cancelled: boolean;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
};

function logHttpForwardAborted(fields: {
  status: number;
  sent: number;
  expected: number | null;
  reason: string;
}): void {
  const now = Date.now();
  if (now - lastHttpForwardAbortLogAt < HTTP_FORWARD_ABORT_LOG_INTERVAL_MS) return;
  lastHttpForwardAbortLogAt = now;
  console.warn(
    `[mesh][http] forward aborted status=${fields.status} sent=${fields.sent} expected=${fields.expected ?? '-'} reason=${fields.reason}`
  );
}

function failHttpStreamBody(
  state: HttpBodyState,
  expectedLength: number | null,
  status: number,
  err: unknown
): void {
  const error = err instanceof Error ? err : new Error(String(err ?? 'http body aborted'));
  if (!state.failed) {
    state.failed = true;
    logHttpForwardAborted({
      status,
      sent: state.sent,
      expected: expectedLength,
      reason: error.message,
    });
  }
  try {
    state.controller?.error(error);
  } catch {
    // already closed/errored
  }
}

type HttpBodyPump = {
  stream: LinkStream;
  rest: Uint8Array[];
  restIndex: number;
  reader: ReadableStreamDefaultReader<StreamChunk> | null;
  expectedLength: number | null;
  state: HttpBodyState;
  fail: (err: unknown) => void;
};

function finishHttpResponseBody(
  pump: HttpBodyPump,
  controller: ReadableStreamDefaultController<Uint8Array>
): void {
  const { state, expectedLength } = pump;
  if (state.aborted) {
    pump.fail(new Error('http stream aborted'));
    return;
  }
  if (expectedLength !== null && state.sent < expectedLength) {
    pump.fail(new Error(`http body truncated: sent=${state.sent} expected=${expectedLength}`));
    return;
  }
  controller.close();
}

// 每次 pull 只推进一个 chunk：先吐已收到的 rest，再对上游 LinkStream 做恰好一次 read。
// 消费者不拉就不读上游，窗口信用不回，背压沿 LinkStream 传回对端。
async function pullHttpResponseBody(
  pump: HttpBodyPump,
  controller: ReadableStreamDefaultController<Uint8Array>
): Promise<void> {
  const { state } = pump;
  if (state.cancelled) return;
  if (state.aborted || state.failed) return pump.fail(new Error('http stream aborted'));
  try {
    const queued = pump.rest[pump.restIndex];
    if (queued) {
      pump.restIndex += 1;
      state.sent += queued.byteLength;
      controller.enqueue(queued);
      return;
    }
    pump.reader ??= pump.stream.readable.getReader();
    while (true) {
      const { done, value } = await pump.reader.read();
      if (state.cancelled || state.failed) return;
      if (done) return finishHttpResponseBody(pump, controller);
      if (!value) continue;
      state.sent += value.bytes.byteLength;
      controller.enqueue(value.bytes);
      return;
    }
  } catch (err) {
    pump.fail(err);
  }
}

function cancelHttpResponseBody(pump: HttpBodyPump, rst: () => void): void {
  pump.state.cancelled = true;
  rst();
  pump.reader?.cancel().catch(() => {});
}

export function responseFromHttpHead(
  stream: LinkStream,
  head: HttpHeadResult,
  rst: () => void
): Response {
  const expectedLength = parseContentLengthHeader(head.headers);
  const state: HttpBodyState = {
    sent: 0,
    failed: false,
    aborted: false,
    cancelled: false,
    controller: null,
  };
  const fail = (err: unknown) => failHttpStreamBody(state, expectedLength, head.status, err);
  const pump: HttpBodyPump = {
    stream,
    rest: head.rest,
    restIndex: 0,
    reader: null,
    expectedLength,
    state,
    fail,
  };

  stream.onAbort(() => {
    state.aborted = true;
    fail(new Error('http stream aborted'));
  });
  void stream.closed.then((info) => {
    if (info.reason === 'end') return;
    console.warn(
      `[mesh][http] stream closed after head reason=${info.reason} message=${info.message ?? ''} sent=${state.sent}`
    );
  });

  const responseBody = new ReadableStream<Uint8Array>({
    start(controller) {
      state.controller = controller;
      if (state.aborted) fail(new Error('http stream aborted'));
    },
    pull: (controller) => pullHttpResponseBody(pump, controller),
    cancel: () => cancelHttpResponseBody(pump, rst),
  });
  return new Response(responseBody, { status: head.status, headers: head.headers });
}
