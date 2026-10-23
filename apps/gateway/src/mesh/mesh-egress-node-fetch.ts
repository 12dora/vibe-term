// 直连 HTTP：走 node:http/https，不读 HTTP_PROXY。映射 mesh 拨号用到的 tls / abort / 流式 body。

import http, {
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { Readable } from 'node:stream';
import type { PeerCertificate } from 'node:tls';
import { stripHostBrackets } from './mesh-egress-noproxy';

export type MeshFetchTls = {
  ca?: string | string[] | Buffer | Buffer[];
  rejectUnauthorized?: boolean;
  serverName?: string;
  checkServerIdentity?: (hostname: string, cert: PeerCertificate) => Error | undefined;
};

export type MeshFetchInit = RequestInit & { tls?: MeshFetchTls };

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type NodeBody = Buffer | string | Readable | undefined;

type NodeReq = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: NodeBody;
  signal?: AbortSignal;
  redirect: RequestRedirect;
  tls?: MeshFetchTls;
  hops: number;
};

export async function nodeMeshFetch(
  input: RequestInfo | URL,
  init?: MeshFetchInit
): Promise<Response> {
  const fromReq = input instanceof Request ? input : null;
  const headers = headerRecord(init?.headers ?? fromReq?.headers);
  const bodyInit = init && 'body' in init ? init.body : fromReq?.body;
  return dispatchNodeRequest({
    url: requestUrl(input),
    method: (init?.method ?? fromReq?.method ?? 'GET').toUpperCase(),
    headers,
    body: await encodeBody(bodyInit, headers),
    signal: init?.signal ?? fromReq?.signal,
    redirect: init?.redirect ?? 'follow',
    tls: init?.tls,
    hops: 0,
  });
}

async function dispatchNodeRequest(req: NodeReq): Promise<Response> {
  if (req.signal?.aborted) throw abortError(req.signal);
  const incoming = await performNodeRequest(req);
  const status = incoming.statusCode ?? 0;
  if (!REDIRECT_STATUSES.has(status)) return toResponse(incoming);
  return handleRedirect(req, incoming, status);
}

function handleRedirect(
  req: NodeReq,
  incoming: IncomingMessage,
  status: number
): Promise<Response> {
  if (req.redirect === 'manual') return Promise.resolve(toResponse(incoming));
  if (req.redirect === 'error') {
    incoming.resume();
    throw new TypeError('fetch was redirected');
  }
  if (req.hops >= MAX_REDIRECTS) {
    incoming.resume();
    throw new TypeError('too many redirects');
  }
  const location = incoming.headers.location;
  if (typeof location !== 'string' || !location) return Promise.resolve(toResponse(incoming));
  incoming.resume();
  return dispatchNodeRequest(nextRequest(req, new URL(location, req.url), status));
}

function nextRequest(req: NodeReq, url: URL, status: number): NodeReq {
  const drop = status === 303 || ((status === 301 || status === 302) && req.method === 'POST');
  if (drop) {
    return { ...req, url, method: 'GET', body: undefined, hops: req.hops + 1 };
  }
  if (req.body instanceof Readable) {
    throw new TypeError('cannot follow redirect with streamed body');
  }
  return { ...req, url, hops: req.hops + 1 };
}

function performNodeRequest(req: NodeReq): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const isHttps = req.url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const request = lib.request(
      {
        hostname: stripHostBrackets(req.url.hostname),
        port: req.url.port ? Number(req.url.port) : isHttps ? 443 : 80,
        path: `${req.url.pathname}${req.url.search}`,
        method: req.method,
        headers: req.headers,
        signal: req.signal,
        ...(isHttps ? tlsOptions(req.tls) : {}),
      },
      resolve
    );
    request.on('error', reject);
    writeRequestBody(request, req.body);
  });
}

function writeRequestBody(request: ClientRequest, body: NodeBody): void {
  if (body === undefined) {
    request.end();
    return;
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    request.end(body);
    return;
  }
  body.pipe(request);
}

function tlsOptions(tls?: MeshFetchTls): RequestOptions {
  if (!tls) return {};
  const out: RequestOptions = {};
  if (tls.ca !== undefined) out.ca = tls.ca;
  if (tls.rejectUnauthorized !== undefined) out.rejectUnauthorized = tls.rejectUnauthorized;
  if (tls.serverName) out.servername = tls.serverName;
  if (tls.checkServerIdentity) out.checkServerIdentity = tls.checkServerIdentity;
  return out;
}

function toResponse(incoming: IncomingMessage): Response {
  const status = incoming.statusCode ?? 200;
  const headers = incomingToHeaders(incoming.headers);
  const init = { status, statusText: incoming.statusMessage, headers };
  if (status === 204 || status === 205 || status === 304) {
    incoming.resume();
    return new Response(null, init);
  }
  // node:stream/web 与 DOM 的 ReadableStream 只是类型声明不同，运行时同一实现
  return new Response(Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, init);
}

function incomingToHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function headerRecord(headers?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

async function encodeBody(
  body: BodyInit | null | undefined,
  headers: Record<string, string>
): Promise<NodeBody> {
  if (body == null) return undefined;
  const buffered = encodeBufferLike(body);
  if (buffered !== null) return buffered;
  if (body instanceof URLSearchParams) {
    setDefaultHeader(headers, 'content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    return body.toString();
  }
  const streamed = encodeStreamLike(body, headers);
  if (streamed !== null) return streamed;
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return encodeFormData(body, headers);
  }
  throw new TypeError('unsupported meshFetch body');
}

function encodeBufferLike(body: BodyInit): Buffer | string | null {
  if (typeof body === 'string') return body;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  return null;
}

function encodeStreamLike(body: BodyInit, headers: Record<string, string>): Readable | null {
  if (body instanceof Blob) {
    if (body.type) setDefaultHeader(headers, 'content-type', body.type);
    setDefaultHeader(headers, 'content-length', String(body.size));
    return webToNodeStream(body.stream());
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return webToNodeStream(body);
  }
  return null;
}

function webToNodeStream(stream: ReadableStream): Readable {
  // DOM 与 node:stream/web 的 ReadableStream 只是类型声明不同，运行时同一实现
  return Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]);
}

async function encodeFormData(body: FormData, headers: Record<string, string>): Promise<Buffer> {
  const wrapped = new Request('http://mesh.invalid/', { method: 'POST', body });
  const type = wrapped.headers.get('content-type');
  if (type) setDefaultHeader(headers, 'content-type', type);
  return Buffer.from(await wrapped.arrayBuffer());
}

function setDefaultHeader(headers: Record<string, string>, name: string, value: string): void {
  if (hasHeader(headers, name)) return;
  headers[name] = value;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) return true;
  }
  return false;
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}
