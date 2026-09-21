import type { LinkStream } from '@vibeterm/shared/link';
import { parseContentLengthHeader } from './forwarder-attempt-deadline';
import type { HttpHeadResult } from './stream-http-head';

const HTTP_FORWARD_ABORT_LOG_INTERVAL_MS = 1_000;
let lastHttpForwardAbortLogAt = 0;

type HttpBodyState = {
  sent: number;
  failed: boolean;
  aborted: boolean;
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

async function readHttpResponseChunks(
  reader: ReadableStreamDefaultReader<{ bytes: Uint8Array }>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  state: HttpBodyState
): Promise<boolean> {
  while (true) {
    if (state.failed) return false;
    const { done, value } = await reader.read();
    if (done) return true;
    if (value) {
      state.sent += value.bytes.byteLength;
      controller.enqueue(value.bytes);
    }
  }
}

async function pumpHttpResponseBody(input: {
  stream: LinkStream;
  rest: Uint8Array[];
  expectedLength: number | null;
  state: HttpBodyState;
  fail: (err: unknown) => void;
}): Promise<void> {
  const controller = input.state.controller;
  if (!controller) return;
  if (input.state.aborted || input.state.failed) {
    input.fail(new Error('http stream aborted'));
    return;
  }
  for (const chunk of input.rest) {
    input.state.sent += chunk.byteLength;
    controller.enqueue(chunk);
  }
  const reader = input.stream.readable.getReader();
  try {
    const finished = await readHttpResponseChunks(reader, controller, input.state);
    if (!finished) return;
    if (input.state.aborted) return input.fail(new Error('http stream aborted'));
    if (input.expectedLength !== null && input.state.sent < input.expectedLength) {
      return input.fail(
        new Error(`http body truncated: sent=${input.state.sent} expected=${input.expectedLength}`)
      );
    }
    controller.close();
  } catch (err) {
    input.fail(err);
  }
}

export function responseFromHttpHead(
  stream: LinkStream,
  head: HttpHeadResult,
  rst: () => void
): Response {
  const expectedLength = parseContentLengthHeader(head.headers);
  const state: HttpBodyState = { sent: 0, failed: false, aborted: false, controller: null };
  const fail = (err: unknown) => failHttpStreamBody(state, expectedLength, head.status, err);

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
    async start(controller) {
      state.controller = controller;
      await pumpHttpResponseBody({
        stream,
        rest: head.rest,
        expectedLength,
        state,
        fail,
      });
    },
    cancel() {
      rst();
    },
  });
  return new Response(responseBody, { status: head.status, headers: head.headers });
}
