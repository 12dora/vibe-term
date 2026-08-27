import type { LinkSession } from '@tmex/shared/link';
import { buildSetCookie, nodeSessionCookieName, parseCookies } from '../auth/cookies';
import {
  MESH_ALLOWED_MIME,
  MESH_FORWARD_CSP,
  MESH_FORWARD_WS_KIND,
  MESH_VIA_SELF,
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type OpenedWsStream,
  type PeerLinkProvider,
  type StreamOpener,
  WS_CLOSE_LOGIN_REQUIRED,
  X_TMEX_SESSION_RENEWED,
  X_TMEX_SET_SESSION,
  getMeshRequestContext,
  setMeshRequestContext,
} from './mesh-deps';
import { isHttps, jsonError } from './session-middleware';
import { NodeUnreachableError } from './types';

const AUTH_SKIP = new Set(['/api/auth/challenge', '/api/auth/login']);

const RESPONSE_ALLOW = new Set([
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'content-disposition',
]);

export type ForwarderDeps = {
  nodeId: string;
  peers: PeerLinkProvider;
  streams: StreamOpener;
};

export type ForwardResult = Response | null | undefined;

const selfRewrites = new WeakMap<Request, string>();

export function getSelfRewrite(req: Request): string | null {
  return selfRewrites.get(req) ?? getMeshRequestContext(req).selfRewrite ?? null;
}

export function parseNodePrefix(pathname: string): { nodeId: string; rest: string } | null {
  const match = pathname.match(/^\/n\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const nodeId = decodeURIComponent(match[1] ?? '');
  const rest = match[2] && match[2].length > 0 ? match[2] : '/';
  return { nodeId, rest };
}

export class Forwarder {
  private readonly pumps = new Map<MeshServerWebSocket, OpenedWsStream>();

  constructor(private readonly deps: ForwarderDeps) {}

  async handle(req: Request, server: MeshUpgradeServer): Promise<ForwardResult> {
    const url = new URL(req.url);
    const parsed = parseNodePrefix(url.pathname);
    if (!parsed) return null;
    if (this.isLocalNode(parsed.nodeId)) {
      return this.handleSelf(req, parsed.rest, url.search);
    }
    if (parsed.rest === '/ws') {
      return this.handleRemoteWs(req, server, parsed.nodeId);
    }
    if (parsed.rest === '/api' || parsed.rest.startsWith('/api/')) {
      return this.handleRemoteHttp(req, parsed.nodeId, parsed.rest, url.search);
    }
    return null;
  }

  handleForwardSocketOpen(ws: MeshServerWebSocket): void {
    void ws;
  }

  handleForwardSocketMessage(ws: MeshServerWebSocket, message: unknown): void {
    const stream = this.pumps.get(ws);
    if (!stream) return;
    const bytes = toBytes(message);
    if (bytes) stream.send(bytes);
  }

  handleForwardSocketClose(ws: MeshServerWebSocket, code?: number, reason?: string): void {
    const stream = this.pumps.get(ws);
    this.pumps.delete(ws);
    stream?.close(code, reason);
  }

  attachForwardPump(ws: MeshServerWebSocket, stream: OpenedWsStream): void {
    this.pumps.set(ws, stream);
    stream.onMessage((bytes) => {
      try {
        ws.send(bytes);
      } catch {
        stream.close();
      }
    });
    stream.onClose((info) => {
      this.pumps.delete(ws);
      try {
        ws.close(info.code, info.reason);
      } catch {
        // already closed
      }
    });
  }

  private isLocalNode(id: string): boolean {
    return id === MESH_VIA_SELF || id === this.deps.nodeId;
  }

  private handleSelf(req: Request, rest: string, search: string): null {
    const rewrite = rest + search;
    selfRewrites.set(req, rewrite);
    const ctx = getMeshRequestContext(req);
    setMeshRequestContext(req, { ...ctx, via: MESH_VIA_SELF, selfRewrite: rewrite });
    return null;
  }

  private async handleRemoteHttp(
    req: Request,
    nodeId: string,
    rest: string,
    search: string
  ): Promise<Response> {
    let link: LinkSession;
    try {
      link = await this.deps.peers.getLink(nodeId);
    } catch {
      return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    }
    const headers = filterRequestHeaders(req);
    const auth = AUTH_SKIP.has(stripQuery(rest))
      ? null
      : (parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId)) ?? null);
    const origin = req.headers.get('origin') ?? new URL(req.url).origin;
    const abort = new AbortController();
    req.signal.addEventListener('abort', () => abort.abort(), { once: true });
    const body = req.body && req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null;
    let upstream: Response;
    try {
      upstream = await this.deps.streams.openHttpStream(
        link,
        {
          method: req.method,
          path: rest,
          query: search,
          headers,
          origin,
          auth,
        },
        body,
        abort.signal
      );
    } catch (err) {
      if (err instanceof NodeUnreachableError) {
        return jsonError('NODE_UNREACHABLE', 503, { nodeId });
      }
      return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    }
    return this.adaptResponse(req, upstream, nodeId);
  }

  private async handleRemoteWs(
    req: Request,
    server: MeshUpgradeServer,
    nodeId: string
  ): Promise<Response | undefined> {
    const auth = parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId)) ?? null;
    if (!auth) {
      const upgraded = server.upgrade(req, {
        data: { kind: MESH_FORWARD_WS_KIND, nodeId, auth: null },
      });
      if (!upgraded) {
        return jsonError('UNAUTHORIZED', 401, { code: 'NODE_LOGIN_REQUIRED', nodeId });
      }
      return undefined;
    }
    let link: LinkSession;
    try {
      link = await this.deps.peers.getLink(nodeId);
    } catch {
      return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    }
    let stream: OpenedWsStream;
    try {
      stream = await this.deps.streams.openWsStream(link, auth);
    } catch {
      return jsonError('NODE_UNREACHABLE', 503, { nodeId });
    }
    const token = crypto.randomUUID();
    pendingStreams.set(token, stream);
    const ok = server.upgrade(req, {
      data: { kind: MESH_FORWARD_WS_KIND, nodeId, auth, token },
    });
    if (!ok) {
      pendingStreams.delete(token);
      stream.close();
      return jsonError('upgrade_failed', 500);
    }
    return undefined;
  }

  private async adaptResponse(req: Request, upstream: Response, nodeId: string): Promise<Response> {
    const headers = new Headers();
    let contentType = '';
    let contentDisposition: string | null = null;
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'content-type') {
        contentType = value;
        return;
      }
      if (lower === 'content-disposition') {
        contentDisposition = value;
        return;
      }
      if (RESPONSE_ALLOW.has(lower) || lower.startsWith('x-tmex-')) {
        headers.set(key, value);
      }
    });
    const mime = baseMime(contentType);
    if (mime && MESH_ALLOWED_MIME.has(mime)) {
      headers.set('content-type', contentType || mime);
      if (contentDisposition) headers.set('content-disposition', contentDisposition);
    } else {
      headers.set('content-type', 'application/octet-stream');
      headers.set('content-disposition', 'attachment');
    }
    headers.set('content-security-policy', MESH_FORWARD_CSP);
    headers.set('x-content-type-options', 'nosniff');

    const setSession = upstream.headers.get(X_TMEX_SET_SESSION);
    if (setSession) {
      const parsed = parseSetSession(setSession);
      if (parsed) {
        headers.append(
          'set-cookie',
          buildSetCookie(nodeSessionCookieName(nodeId), parsed.sid, {
            maxAgeSec: parsed.maxAgeSec,
            secure: isHttps(req),
          })
        );
      }
    }
    const renewed = upstream.headers.get(X_TMEX_SESSION_RENEWED);
    if (renewed) {
      headers.set(X_TMEX_SESSION_RENEWED, renewed);
      const sid = parseCookies(req.headers.get('cookie')).get(nodeSessionCookieName(nodeId));
      const expiresAt = Number(renewed);
      if (sid && Number.isFinite(expiresAt)) {
        const maxAgeSec = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
        headers.append(
          'set-cookie',
          buildSetCookie(nodeSessionCookieName(nodeId), sid, {
            maxAgeSec,
            secure: isHttps(req),
          })
        );
      }
    }

    if (upstream.status !== 401) {
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    const raw = await upstream.text();
    let body: Record<string, unknown> = { code: 'NODE_LOGIN_REQUIRED', nodeId };
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = { ...(parsed as Record<string, unknown>), code: 'NODE_LOGIN_REQUIRED', nodeId };
      }
    } catch {
      if (raw) body.message = raw;
    }
    if (
      !headers.has('content-type') ||
      headers.get('content-type') === 'application/octet-stream'
    ) {
      headers.set('content-type', 'application/json');
      headers.delete('content-disposition');
    } else {
      headers.set('content-type', 'application/json');
    }
    return new Response(JSON.stringify(body), { status: 401, headers });
  }
}

const pendingStreams = new Map<string, OpenedWsStream>();

export function takePendingForwardStream(token: string | undefined): OpenedWsStream | undefined {
  if (!token) return undefined;
  const stream = pendingStreams.get(token);
  if (stream) pendingStreams.delete(token);
  return stream;
}

function filterRequestHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === 'cookie' ||
      lower === 'authorization' ||
      lower === 'host' ||
      lower === 'connection' ||
      lower === 'upgrade' ||
      lower.startsWith('proxy-') ||
      lower.startsWith('x-forwarded-')
    ) {
      return;
    }
    out[key] = value;
  });
  return out;
}

function stripQuery(path: string): string {
  const i = path.indexOf('?');
  return i === -1 ? path : path.slice(0, i);
}

function baseMime(contentType: string): string {
  const trimmed = contentType.trim().toLowerCase();
  if (!trimmed) return '';
  const semi = trimmed.indexOf(';');
  return (semi === -1 ? trimmed : trimmed.slice(0, semi)).trim();
}

function parseSetSession(value: string): { sid: string; maxAgeSec: number } | null {
  const split = value.indexOf(';');
  if (split === -1) return null;
  const sid = value.slice(0, split).trim();
  const maxAgeSec = Number(value.slice(split + 1).trim());
  if (!sid || !Number.isFinite(maxAgeSec)) return null;
  return { sid, maxAgeSec };
}

function toBytes(message: unknown): Uint8Array | null {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return null;
}
