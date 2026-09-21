import type { LinkStream, StreamChunk } from '@vibeterm/shared/link';
import { armDeferredTimeout } from './forwarder-attempt-deadline';
import { parseOpenPayload } from './peer-protocol';
import { stringHeaders, stripSetCookieHeaders } from './stream-http-headers';

export type HttpHeadResult = {
  status: number;
  headers: Record<string, string>;
  rest: Uint8Array[];
};

export async function readHttpHead(
  stream: LinkStream,
  opts: { timeoutMs: number; armAfter?: Promise<unknown>; abort?: AbortSignal }
): Promise<HttpHeadResult> {
  const reader = stream.readable.getReader();
  const rest: Uint8Array[] = [];
  let rejectTimeout: ((err: Error) => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const armed = armDeferredTimeout({
    timeoutMs: opts.timeoutMs,
    armAfter: opts.armAfter,
    abort: opts.abort,
    onTimeout: () => {
      try {
        stream.reset('head-timeout');
      } catch {
        // already closed
      }
      rejectTimeout?.(new Error('http head timeout'));
    },
  });
  try {
    return await Promise.race([readHttpHeadLoop(reader, rest), timeout]);
  } finally {
    armed.dispose();
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

async function readHttpHeadLoop(
  reader: ReadableStreamDefaultReader<StreamChunk>,
  rest: Uint8Array[]
): Promise<HttpHeadResult> {
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) {
      throw new Error('http stream closed before response head');
    }
    if (value.head) {
      const parsed = parseOpenPayload(value.bytes) ?? {};
      return {
        status: typeof parsed.status === 'number' ? parsed.status : 200,
        headers: stripSetCookieHeaders(stringHeaders(parsed.headers)),
        rest,
      };
    }
    rest.push(value.bytes);
  }
}
