import { wsBorsh } from '@tmex/shared';
import type { LinkSession, LinkStream } from '@tmex/shared/link';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { WebSocketServer } from '../ws';
import type { GatewaySession } from '../ws/gateway-session';
import { encodeJsonBytes, isRecord } from './ctl';
import { LinkStreamCarrier } from './link-stream-carrier';
import { X_TMEX_SESSION_RENEWED } from './mesh-deps';
import { parseOpenPayload } from './peer-protocol';
import type { DispatchHttp, HttpStreamOpenPayload, WsStreamOpenPayload } from './types';

const AUTH_SKIP_PATHS = new Set(['/api/auth/challenge', '/api/auth/login']);

const BLOCKED_REQUEST_HEADERS = new Set([
  'cookie',
  'authorization',
  'host',
  'connection',
  'upgrade',
  'x-tmex-via',
]);

export type StreamAuthContext = {
  peerNodeId: string;
  sessionStore: NodeSessionStore;
  now?: () => number;
};

export type StreamAuthOk = {
  ok: true;
  uid: string | null;
  renewedExpiresAt?: number;
};

export function isAuthSkippedPath(path: string): boolean {
  const bare = path.split('?')[0] ?? path;
  return AUTH_SKIP_PATHS.has(bare);
}

export function stripForwardedRequestHeaders(
  headers?: Record<string, string> | null
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith('proxy-')) continue;
    if (lower.startsWith('x-forwarded-')) continue;
    out[key] = value;
  }
  return out;
}

export function stripSetCookieHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'set-cookie') continue;
    out[key] = value;
  }
  return out;
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    out[key] = value;
  });
  return out;
}

function verifyAuth(
  auth: string | null | undefined,
  path: string,
  ctx: StreamAuthContext
): StreamAuthOk | { ok: false; reason: string } {
  if (isAuthSkippedPath(path)) {
    return { ok: true, uid: null };
  }
  if (!auth) {
    return { ok: false, reason: 'missing auth' };
  }
  const result = ctx.sessionStore.verify(auth, {
    viaNodeId: ctx.peerNodeId,
    now: ctx.now?.() ?? Date.now(),
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  return {
    ok: true,
    uid: result.session.userId,
    ...(result.renewedExpiresAt !== undefined ? { renewedExpiresAt: result.renewedExpiresAt } : {}),
  };
}

export async function acceptHttpStream(
  stream: LinkStream,
  opts: StreamAuthContext & { dispatchHttp: DispatchHttp }
): Promise<void> {
  const open = parseOpenPayload(stream.openPayload) ?? {};
  const method = typeof open.method === 'string' ? open.method : 'GET';
  const path = typeof open.path === 'string' ? open.path : '/';
  const query = typeof open.query === 'string' ? open.query : '';
  const origin = typeof open.origin === 'string' ? open.origin : 'http://localhost';
  const headers = stripForwardedRequestHeaders(
    isRecord(open.headers)
      ? Object.fromEntries(
          Object.entries(open.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : {}
  );
  const auth = typeof open.auth === 'string' ? open.auth : null;
  const verified = verifyAuth(auth, path, opts);
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
    try {
      void requestReader?.cancel();
    } catch {
      // already cancelled
    }
    try {
      void responseReader?.cancel();
    } catch {
      // already cancelled
    }
  };

  stream.onAbort(() => {
    if (!abort.signal.aborted) abort.abort();
    cancelReaders();
  });

  if (hasBody) {
    requestReader = stream.readable.getReader();
  }

  const requestBody = hasBody
    ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          const reader = requestReader;
          if (!reader) {
            controller.close();
            return;
          }
          while (true) {
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
            if (chunk.value && chunk.value.bytes.byteLength > 0) {
              controller.enqueue(chunk.value.bytes);
              return;
            }
          }
        },
        cancel() {
          if (!abort.signal.aborted) abort.abort();
          if (!responseComplete) {
            try {
              stream.reset('request-cancelled');
            } catch {
              // already reset
            }
          }
        },
      })
    : null;

  const url = new URL(path + query, origin.endsWith('/') ? origin : `${origin}/`);
  const request = new Request(url, {
    method,
    headers,
    body: requestBody ?? undefined,
    signal: abort.signal,
  });

  let response: Response;
  try {
    response = await opts.dispatchHttp(request, {
      uid: verified.uid,
      viaNodeId: opts.peerNodeId,
      ...(verified.renewedExpiresAt !== undefined
        ? { renewedExpiresAt: verified.renewedExpiresAt }
        : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'dispatch failed';
    await writeHttpResponse(stream, 500, { 'content-type': 'text/plain' }, message);
    return;
  }

  const responseHeaders = stripSetCookieHeaders(headerRecord(response.headers));
  if (verified.renewedExpiresAt !== undefined) {
    responseHeaders[X_TMEX_SESSION_RENEWED] = String(verified.renewedExpiresAt);
  }

  try {
    await stream.write(encodeJsonBytes({ status: response.status, headers: responseHeaders }), {
      head: true,
    });
    if (response.body) {
      responseReader = response.body.getReader();
      try {
        while (true) {
          if (abort.signal.aborted) break;
          const { done, value } = await responseReader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await stream.write(value);
          }
        }
      } catch {
        if (!abort.signal.aborted && !responseComplete) {
          stream.reset('response-cancelled');
        }
        return;
      }
    }
    await stream.end();
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
    if (body) {
      await stream.write(new TextEncoder().encode(body));
    }
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
  const writeBody = (async () => {
    if (!body) {
      await stream.end();
      return;
    }
    if (body instanceof Uint8Array) {
      if (body.byteLength > 0 && !stopUpload.signal.aborted) await stream.write(body);
      if (!stopUpload.signal.aborted) await stream.end();
      return;
    }
    upload.reader = body.getReader();
    try {
      while (!stopUpload.signal.aborted) {
        const { done, value } = await upload.reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await stream.write(value);
        }
      }
      if (!stopUpload.signal.aborted) await stream.end();
    } catch {
      if (!gotHead && !stopUpload.signal.aborted) rst();
    }
  })();

  try {
    const head = await readHttpHead(stream);
    gotHead = true;
    if (!stopUpload.signal.aborted) stopUpload.abort();
    try {
      await upload.reader?.cancel();
    } catch {
      // writer stopped
    }
    const responseBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of head.rest) {
          controller.enqueue(chunk);
        }
        const reader = stream.readable.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value.bytes);
          }
          controller.close();
        } catch (err) {
          if (head.status) {
            try {
              controller.close();
            } catch {
              controller.error(err);
            }
          } else {
            controller.error(err);
          }
        }
      },
      cancel() {
        rst();
      },
    });
    return new Response(responseBody, { status: head.status, headers: head.headers });
  } finally {
    signal?.removeEventListener('abort', onOuterAbort);
    void writeBody;
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
        const status = typeof parsed.status === 'number' ? parsed.status : 200;
        const headers = stripSetCookieHeaders(
          isRecord(parsed.headers)
            ? Object.fromEntries(
                Object.entries(parsed.headers).filter(
                  (entry): entry is [string, string] => typeof entry[1] === 'string'
                )
              )
            : {}
        );
        return { status, headers, rest };
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

export type AcceptWsStreamOptions = StreamAuthContext & {
  wsServer: WebSocketServer;
  onGatewaySession?: (
    session: GatewaySession,
    auth: { sid: string; uid: string; via: string }
  ) => void;
  onGatewaySessionClose?: (session: GatewaySession) => void;
};

export async function acceptWsStream(
  stream: LinkStream,
  opts: AcceptWsStreamOptions
): Promise<void> {
  const open = parseOpenPayload(stream.openPayload) ?? {};
  const auth = typeof open.auth === 'string' ? open.auth : '';
  const verified = verifyAuth(auth, '/ws', opts);
  if (!verified.ok) {
    stream.reset(verified.reason);
    return;
  }
  const sid = auth;
  const via = opts.peerNodeId;
  const uid = verified.uid;
  const carrier = new LinkStreamCarrier(stream);
  const attached = opts.wsServer.attachStreamSession(carrier);
  opts.onGatewaySession?.(attached.session, { sid, uid: uid ?? '', via });
  let tornDown = false;
  const teardown = (mode: 'end' | 'rst', reason?: string) => {
    if (tornDown) return;
    tornDown = true;
    try {
      opts.onGatewaySessionClose?.(attached.session);
    } catch {
      // registry
    }
    try {
      attached.onClose();
    } catch {
      // session already gone
    }
    try {
      if (mode === 'rst') stream.reset(reason ?? 'session-invalid');
      else void stream.end();
    } catch {
      // already closed
    }
  };
  stream.onAbort(() => teardown('rst', 'peer-rst'));
  const reader = stream.readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        teardown('end');
        return;
      }
      if (!value) continue;
      try {
        wsBorsh.decodeEnvelope(value.bytes);
      } catch {
        teardown('rst', 'invalid-ws-frame');
        return;
      }
      const check = opts.sessionStore.verify(sid, {
        viaNodeId: via,
        now: opts.now?.() ?? Date.now(),
      });
      if (!check.ok) {
        teardown('rst', check.reason);
        return;
      }
      void uid;
      attached.onMessage(value.bytes);
    }
  } catch {
    teardown('rst', 'ws-read-failed');
  }
}

export async function openWsStream(
  link: LinkSession,
  auth: string
): Promise<{
  stream: LinkStream;
  send: (bytes: Uint8Array) => Promise<void>;
  readable: ReadableStream<Uint8Array>;
  close: () => void;
}> {
  const payload: WsStreamOpenPayload = { type: 'ws', auth };
  const stream = await link.openStream(encodeJsonBytes(payload));
  return {
    stream,
    send: (bytes) => stream.write(bytes),
    readable: stream.readable.pipeThrough(
      new TransformStream<{ bytes: Uint8Array; head: boolean }, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk.bytes);
        },
      })
    ),
    close: () => {
      void stream.end();
    },
  };
}

export function classifyOpenPayload(bytes: Uint8Array): 'http' | 'ws' | 'relay' | 'unknown' {
  const open = parseOpenPayload(bytes);
  if (!open) return 'unknown';
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
