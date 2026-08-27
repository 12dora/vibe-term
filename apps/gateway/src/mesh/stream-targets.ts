import type { LinkSession, LinkStream } from '@tmex/shared/link';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { WebSocketServer } from '../ws';
import { encodeJsonBytes, isRecord } from './ctl';
import { LinkStreamCarrier } from './link-stream-carrier';
import { parseOpenPayload } from './peer-protocol';
import type { DispatchHttp, HttpStreamOpenPayload, WsStreamOpenPayload } from './types';

const AUTH_SKIP_PATHS = new Set(['/api/auth/challenge', '/api/auth/login']);

export type StreamAuthContext = {
  peerNodeId: string;
  sessionStore: NodeSessionStore;
  now?: () => number;
};

export function isAuthSkippedPath(path: string): boolean {
  const bare = path.split('?')[0] ?? path;
  return AUTH_SKIP_PATHS.has(bare);
}

function verifyAuth(
  auth: string | null | undefined,
  path: string,
  ctx: StreamAuthContext
): { ok: true; uid: string } | { ok: false; reason: string } {
  if (isAuthSkippedPath(path)) {
    return { ok: true, uid: '' };
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
  return { ok: true, uid: result.session.userId };
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
  const headers = isRecord(open.headers)
    ? Object.fromEntries(
        Object.entries(open.headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : {};
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
  stream.onAbort(() => {
    if (!abort.signal.aborted) abort.abort();
  });

  let requestEnded = false;
  const bodyChunks: Uint8Array[] = [];
  let bodyWaiter: (() => void) | null = null;
  let bodyError: Error | null = null;

  const wakeBody = () => {
    const waiter = bodyWaiter;
    bodyWaiter = null;
    waiter?.();
  };

  void (async () => {
    const reader = stream.readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          requestEnded = true;
          wakeBody();
          return;
        }
        if (value && !value.head) {
          bodyChunks.push(value.bytes);
          wakeBody();
        }
      }
    } catch (err) {
      bodyError = err instanceof Error ? err : new Error(String(err));
      if (!abort.signal.aborted) abort.abort();
      wakeBody();
    }
  })();

  const hasBody = method !== 'GET' && method !== 'HEAD';
  const requestBody = hasBody
    ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          while (bodyChunks.length === 0 && !requestEnded && !bodyError) {
            await new Promise<void>((resolve) => {
              bodyWaiter = resolve;
            });
          }
          if (bodyError) {
            controller.error(bodyError);
            return;
          }
          const chunk = bodyChunks.shift();
          if (chunk) {
            controller.enqueue(chunk);
            return;
          }
          controller.close();
        },
        cancel() {
          if (!abort.signal.aborted) abort.abort();
          try {
            stream.reset('request-cancelled');
          } catch {
            // already reset
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
    response = await opts.dispatchHttp(request, { uid: verified.uid });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'dispatch failed';
    await writeHttpResponse(stream, 500, { 'content-type': 'text/plain' }, message);
    return;
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  try {
    await stream.write(encodeJsonBytes({ status: response.status, headers: responseHeaders }), {
      head: true,
    });
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await stream.write(value);
          }
        }
      } catch {
        stream.reset('response-cancelled');
        return;
      }
    }
    stream.end();
    if (!requestEnded) {
      stream.reset('unread-request-body');
    }
  } catch {
    try {
      stream.reset('response-write-failed');
    } catch {
      // already closed
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
    stream.end();
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
  const payload: HttpStreamOpenPayload = { type: 'http', ...openPayload };
  const stream = await link.openStream(encodeJsonBytes(payload));
  const abort = () => {
    try {
      stream.reset('aborted');
    } catch {
      // already reset
    }
  };
  if (signal?.aborted) {
    abort();
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  signal?.addEventListener('abort', abort, { once: true });
  stream.onAbort(() => {
    // RST from peer; reader loop handles it
  });

  const writeBody = (async () => {
    if (!body) {
      stream.end();
      return;
    }
    if (body instanceof Uint8Array) {
      if (body.byteLength > 0) await stream.write(body);
      stream.end();
      return;
    }
    const reader = body.getReader();
    try {
      while (true) {
        if (signal?.aborted) {
          abort();
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await stream.write(value);
        }
      }
      stream.end();
    } catch {
      abort();
    }
  })();

  const head = await readHttpHead(stream);
  void writeBody;
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
      abort();
    },
  });

  return new Response(responseBody, { status: head.status, headers: head.headers });
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
        const headers = isRecord(parsed.headers)
          ? Object.fromEntries(
              Object.entries(parsed.headers).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string'
              )
            )
          : {};
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

export async function acceptWsStream(
  stream: LinkStream,
  opts: StreamAuthContext & { wsServer: WebSocketServer }
): Promise<void> {
  const open = parseOpenPayload(stream.openPayload) ?? {};
  const auth = typeof open.auth === 'string' ? open.auth : '';
  const verified = verifyAuth(auth, '/ws', opts);
  if (!verified.ok) {
    stream.reset(verified.reason);
    return;
  }
  const carrier = new LinkStreamCarrier(stream);
  const attached = opts.wsServer.attachStreamSession(carrier);
  stream.onAbort(() => attached.onClose());
  const reader = stream.readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) attached.onMessage(value.bytes);
    }
  } catch {
    // stream aborted
  } finally {
    attached.onClose();
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
    close: () => stream.end(),
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
