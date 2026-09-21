import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import { DEFAULT_DIAL_RTT_MS } from '@vibeterm/shared/net';
import { encodeJsonBytes } from './ctl';
import {
  UploadStallError,
  httpHeadTimeoutMs,
  wrapUploadDestination,
} from './forwarder-attempt-deadline';
import { parseOpenPayload } from './peer-protocol';
import { attachMeshPeerMarker } from './peer-request-marker';
import {
  type StreamAuthContext,
  type StreamAuthOk,
  authResponseHeaders,
  authorizeHttpStream,
} from './stream-auth';
import { readHttpHead } from './stream-http-head';
import { headerRecord, stringHeaders, stripForwardedRequestHeaders } from './stream-http-headers';
import { responseFromHttpHead } from './stream-http-response';
import { pumpToLink } from './stream-pump';
import type { DispatchContext, DispatchHttp, HttpStreamOpenPayload } from './types';

export type { StreamAuthContext };
export { isAuthSkippedPath } from './stream-auth';
export type { AcceptWsStreamOptions, GatewaySessionClose } from './ws-stream-target';
export { WS_CLOSE_STREAM_TEARDOWN, acceptWsStream, openWsStream } from './ws-stream-target';
export { stripForwardedRequestHeaders };

function resolveInboundHttpUrl(path: string, query: string, origin: string): URL {
  return new URL(path + query, origin.endsWith('/') ? origin : `${origin}/`);
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

function uploadDestination(
  stream: LinkStream,
  stopUpload: AbortController,
  stall: { err?: Error }
): Pick<LinkStream, 'write' | 'end'> {
  return wrapUploadDestination(stream, {
    abort: stopUpload.signal,
    onStall: () => {
      stall.err = new UploadStallError();
      if (!stopUpload.signal.aborted) stopUpload.abort(stall.err);
      try {
        stream.reset('upload-stall');
      } catch {
        // already reset
      }
    },
  });
}

function pumpHttpRequestBody(
  body: ReadableStream<Uint8Array> | Uint8Array | null | undefined,
  stream: LinkStream,
  stopUpload: AbortController,
  shouldReset: () => boolean,
  rst: () => void,
  stall: { err?: Error }
): {
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  armAfter: Promise<unknown> | undefined;
} {
  const isBytes = body instanceof Uint8Array;
  const reader = body && !isBytes ? body.getReader() : null;
  const hasBody = Boolean(body && !(isBytes && body.byteLength === 0));
  const pumpDone = pumpToLink(
    reader ?? (isBytes ? body : null),
    hasBody ? uploadDestination(stream, stopUpload, stall) : stream,
    () => {
      if (shouldReset() && !stopUpload.signal.aborted) rst();
    },
    () => stopUpload.signal.aborted
  );
  return {
    reader,
    armAfter: hasBody
      ? pumpDone.then((ok) => {
          if (!ok) throw new Error('upload failed');
        })
      : undefined,
  };
}

/** HTTP head 等待：RTT 由调用方注入（PeerManager.rttForLink），缺省 800 ms 档。 */
export function httpHeadTimeoutForStream(
  _link: LinkSession,
  rttMs: number = DEFAULT_DIAL_RTT_MS
): number {
  return httpHeadTimeoutMs(rttMs);
}

export async function openHttpStream(
  link: LinkSession,
  openPayload: HttpStreamOpenPayload,
  body?: ReadableStream<Uint8Array> | Uint8Array | null,
  signal?: AbortSignal,
  rttMs: number = DEFAULT_DIAL_RTT_MS
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

  const stall: { err?: Error } = {};
  const upload = pumpHttpRequestBody(body, stream, stopUpload, () => !gotHead, rst, stall);

  try {
    const head = await readHttpHead(stream, {
      timeoutMs: httpHeadTimeoutForStream(link, rttMs),
      armAfter: upload.armAfter,
      abort: signal,
    });
    gotHead = true;
    if (!stopUpload.signal.aborted) stopUpload.abort();
    try {
      await upload.reader?.cancel();
    } catch {
      // writer stopped
    }
    return responseFromHttpHead(stream, head, rst);
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err;
    if (stall.err) throw stall.err;
    throw err;
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
