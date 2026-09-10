import { VIA_HEADER, addHeaderNames } from '@vibeterm/shared/http/mesh-headers';
import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import { encodeJsonBytes, isRecord } from './ctl';
import { parseOpenPayload } from './peer-protocol';
import { MESH_PEER_HEADER, attachMeshPeerMarker } from './peer-request-marker';
import {
  type StreamAuthContext,
  type StreamAuthOk,
  authResponseHeaders,
  authorizeHttpStream,
} from './stream-auth';
import { pumpToLink } from './stream-pump';
import type { DispatchContext, DispatchHttp, HttpStreamOpenPayload } from './types';

export type { StreamAuthContext };
export { isAuthSkippedPath } from './stream-auth';
export type { AcceptWsStreamOptions, GatewaySessionClose } from './ws-stream-target';
export { WS_CLOSE_STREAM_TEARDOWN, acceptWsStream, openWsStream } from './ws-stream-target';

const HTTP_FORWARD_ABORT_LOG_INTERVAL_MS = 1_000;
let lastHttpForwardAbortLogAt = 0;

const BLOCKED_REQUEST_HEADERS = addHeaderNames(
  new Set(['cookie', 'authorization', 'host', 'connection', 'upgrade']),
  VIA_HEADER,
  MESH_PEER_HEADER
);

function resolveInboundHttpUrl(path: string, query: string, origin: string): URL {
  return new URL(path + query, origin.endsWith('/') ? origin : `${origin}/`);
}

export function stripForwardedRequestHeaders(
  headers?: Record<string, string> | null
): Record<string, string> {
  return copyHeaders(
    headers,
    (k) => BLOCKED_REQUEST_HEADERS.has(k) || k.startsWith('proxy-') || k.startsWith('x-forwarded-')
  );
}

export function stripSetCookieHeaders(headers: Record<string, string>): Record<string, string> {
  return copyHeaders(headers, (k) => k === 'set-cookie');
}

function copyHeaders(
  headers: Record<string, string> | null | undefined,
  drop: (lower: string) => boolean
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (!drop(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function parseContentLength(headers: Record<string, string>): number | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'content-length') continue;
    const n = Number(value.trim());
    if (!Number.isInteger(n) || n < 0) return null;
    return n;
  }
  return null;
}

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

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return stripSetCookieHeaders(out);
}

function stringHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string') out[key] = val;
  }
  return out;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function requestBodyFromLink(
  reader: ReadableStreamDefaultReader<{ bytes: Uint8Array; head: boolean }>,
  stream: LinkStream,
  abort: AbortController,
  complete: () => boolean
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          controller.error(err);
          return;
        }
        if (chunk.done) {
          controller.close();
          return;
        }
        if (chunk.value?.head) continue;
        if (chunk.value?.bytes.byteLength) {
          controller.enqueue(chunk.value.bytes);
          return;
        }
      }
    },
    cancel() {
      if (!abort.signal.aborted) abort.abort();
      if (!complete())
        try {
          stream.reset('request-cancelled');
        } catch {
          // already reset
        }
    },
  });
}

/**
 * 会话 id 必须随请求进到目标节点：`/api/mesh/connection`、`/api/rtc/authorize` 要拿它
 * 在会话注册表里定位这条浏览器连接，丢了就只能回 401。分享凭证不产生会话 id。
 */
function httpDispatchContext(
  verified: StreamAuthOk,
  peerNodeId: string,
  auth: string | null
): DispatchContext {
  return {
    uid: verified.uid,
    viaNodeId: peerNodeId,
    ...(verified.uid && auth ? { sid: auth } : {}),
    ...(verified.renewedExpiresAt !== undefined
      ? { renewedExpiresAt: verified.renewedExpiresAt }
      : {}),
  };
}

export async function acceptHttpStream(
  stream: LinkStream,
  opts: StreamAuthContext & { dispatchHttp: DispatchHttp }
): Promise<void> {
  const open = parseOpenPayload(stream.openPayload) ?? {};
  const method = str(open.method, 'GET');
  const path = str(open.path, '/');
  const query = str(open.query);
  const origin = str(open.origin, 'http://localhost');
  const headers = attachMeshPeerMarker(
    stripForwardedRequestHeaders(stringHeaders(open.headers)),
    opts.peerNodeId
  );
  const auth = str(open.auth) || null;
  let url: URL;
  try {
    url = resolveInboundHttpUrl(path, query, origin);
  } catch {
    await writeHttpResponse(
      stream,
      400,
      { 'content-type': 'application/json' },
      JSON.stringify({ error: 'invalid path' })
    );
    return;
  }
  const verified = authorizeHttpStream(auth, method, url.pathname, opts, headers);
  if (!verified.ok) {
    await writeHttpResponse(
      stream,
      401,
      { 'content-type': 'application/json' },
      JSON.stringify({ error: verified.reason })
    );
    return;
  }

  const abort = new AbortController();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  let requestReader: ReadableStreamDefaultReader<{ bytes: Uint8Array; head: boolean }> | null =
    null;
  let responseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let responseComplete = false;
  const cancelReaders = () => {
    void requestReader?.cancel().catch(() => {});
    void responseReader?.cancel().catch(() => {});
  };
  stream.onAbort(() => {
    if (!abort.signal.aborted) abort.abort();
    cancelReaders();
  });
  if (hasBody) requestReader = stream.readable.getReader();
  const requestBody = requestReader
    ? requestBodyFromLink(requestReader, stream, abort, () => responseComplete)
    : null;
  const request = new Request(url, {
    method,
    headers,
    body: requestBody ?? undefined,
    signal: abort.signal,
  });

  let response: Response;
  try {
    response = await opts.dispatchHttp(
      request,
      httpDispatchContext(verified, opts.peerNodeId, auth)
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'dispatch failed';
    await writeHttpResponse(stream, 500, { 'content-type': 'text/plain' }, message);
    return;
  }

  const responseHeaders = authResponseHeaders(headerRecord(response.headers), verified);

  try {
    await stream.write(encodeJsonBytes({ status: response.status, headers: responseHeaders }), {
      head: true,
    });
    responseReader = response.body?.getReader() ?? null;
    if (
      !(await pumpToLink(responseReader, stream, () => {
        if (!abort.signal.aborted && !responseComplete) stream.reset('response-cancelled');
      }))
    ) {
      return;
    }
    responseComplete = true;
  } catch {
    if (!responseComplete) {
      try {
        stream.reset('response-write-failed');
      } catch {
        // already closed
      }
    }
  }
}

async function writeHttpResponse(
  stream: LinkStream,
  status: number,
  headers: Record<string, string>,
  body: string
): Promise<void> {
  try {
    await stream.write(encodeJsonBytes({ status, headers }), { head: true });
    if (body) await stream.write(new TextEncoder().encode(body));
    await stream.end();
  } catch {
    try {
      stream.reset('http-error');
    } catch {
      // already closed
    }
  }
}

export async function openHttpStream(
  link: LinkSession,
  openPayload: HttpStreamOpenPayload,
  body?: ReadableStream<Uint8Array> | Uint8Array | null,
  signal?: AbortSignal
): Promise<Response> {
  const payload: HttpStreamOpenPayload = {
    type: 'http',
    ...openPayload,
    headers: stripForwardedRequestHeaders(openPayload.headers),
  };
  const stream = await link.openStream(encodeJsonBytes(payload));
  const rst = () => {
    try {
      stream.reset('aborted');
    } catch {
      // already reset
    }
  };
  const stopUpload = new AbortController();
  let gotHead = false;
  const onOuterAbort = () => {
    if (!stopUpload.signal.aborted) stopUpload.abort();
    rst();
  };
  if (signal?.aborted) {
    rst();
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  stream.onAbort(() => {
    if (!stopUpload.signal.aborted) stopUpload.abort();
  });

  const upload = { reader: null as ReadableStreamDefaultReader<Uint8Array> | null };
  if (body && !(body instanceof Uint8Array)) upload.reader = body.getReader();
  void pumpToLink(
    upload.reader ?? (body instanceof Uint8Array ? body : null),
    stream,
    () => {
      if (!gotHead && !stopUpload.signal.aborted) rst();
    },
    () => stopUpload.signal.aborted
  );

  try {
    const head = await readHttpHead(stream);
    gotHead = true;
    if (!stopUpload.signal.aborted) stopUpload.abort();
    try {
      await upload.reader?.cancel();
    } catch {
      // writer stopped
    }
    const expectedLength = parseContentLength(head.headers);
    let sent = 0;
    let bodyFailed = false;
    let abortedAfterHead = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const failBody = (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err ?? 'http body aborted'));
      if (!bodyFailed) {
        bodyFailed = true;
        logHttpForwardAborted({
          status: head.status,
          sent,
          expected: expectedLength,
          reason: error.message,
        });
      }
      try {
        bodyController?.error(error);
      } catch {
        // already closed/errored
      }
    };

    stream.onAbort(() => {
      abortedAfterHead = true;
      failBody(new Error('http stream aborted'));
    });
    void stream.closed.then((info) => {
      if (info.reason === 'end') return;
      console.warn(
        `[mesh][http] stream closed after head reason=${info.reason} message=${info.message ?? ''} sent=${sent}`
      );
    });

    const responseBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        bodyController = controller;
        if (abortedAfterHead || bodyFailed) {
          failBody(new Error('http stream aborted'));
          return;
        }
        for (const chunk of head.rest) {
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        }
        const reader = stream.readable.getReader();
        try {
          while (true) {
            if (bodyFailed) return;
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              sent += value.bytes.byteLength;
              controller.enqueue(value.bytes);
            }
          }
          if (abortedAfterHead) return failBody(new Error('http stream aborted'));
          if (expectedLength !== null && sent < expectedLength) {
            return failBody(
              new Error(`http body truncated: sent=${sent} expected=${expectedLength}`)
            );
          }
          controller.close();
        } catch (err) {
          failBody(err);
        }
      },
      cancel() {
        rst();
      },
    });
    return new Response(responseBody, { status: head.status, headers: head.headers });
  } finally {
    signal?.removeEventListener('abort', onOuterAbort);
    if (!stopUpload.signal.aborted) stopUpload.abort();
    try {
      void upload.reader?.cancel().catch(() => {});
    } catch {
      // already released
    }
  }
}

async function readHttpHead(stream: LinkStream): Promise<{
  status: number;
  headers: Record<string, string>;
  rest: Uint8Array[];
}> {
  const reader = stream.readable.getReader();
  const rest: Uint8Array[] = [];
  try {
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
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

export function classifyOpenPayload(
  bytes: Uint8Array
): 'http' | 'ws' | 'tcp' | 'relay' | 'unknown' {
  const open = parseOpenPayload(bytes);
  if (!open) return 'unknown';
  if (open.type === 'tcp') return 'tcp';
  if (open.type === 'http' || (typeof open.method === 'string' && typeof open.path === 'string')) {
    return 'http';
  }
  if (
    open.type === 'ws' ||
    (typeof open.auth === 'string' && open.method === undefined && open.to === undefined)
  ) {
    return 'ws';
  }
  if (typeof open.to === 'string') return 'relay';
  return 'unknown';
}
