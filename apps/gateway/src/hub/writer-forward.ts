import {
  HUB_NOT_WRITER,
  type HubNotWriterError,
  TMEX_FORWARDED_BY_HEADER,
} from '@tmex/shared/uplink';
import { json } from '../api/http';
import type { HubTrustStore } from '../auth/hub-trust-store';
import { uplinkWebSocketTls } from '../mesh/uplink-client';
import { joinHubPath } from '../mesh/uplink-pool';

export const WRITER_FORWARD_TIMEOUT_MS = 10_000;
export const WRITER_FORWARD_HEADER = TMEX_FORWARDED_BY_HEADER;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

const PASS_THROUGH = new Set([
  'cookie',
  'authorization',
  'content-type',
  'accept',
  'x-tmex-force-keylog',
]);

export type WriterForwardTarget = {
  writerHubId: string | null;
  writerPublicUrl: string | null;
  writerEpoch: number | null;
};

export type WriterForwardFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type WriterForwardContext = {
  selfHubId: string;
  target: WriterForwardTarget;
  hubTrust?: HubTrustStore;
  fetch?: WriterForwardFetch;
  timeoutMs?: number;
};

export function notWriterResponse(target: WriterForwardTarget): Response {
  const body: HubNotWriterError = {
    code: HUB_NOT_WRITER,
    writerHubId: target.writerHubId,
    writerPublicUrl: target.writerPublicUrl,
    writerEpoch: target.writerEpoch,
  };
  return json(body, 409);
}

export function requestAlreadyForwarded(req: Request): boolean {
  const value = req.headers.get(WRITER_FORWARD_HEADER);
  return Boolean(value && value.trim().length > 0);
}

export async function forwardWriteToWriter(
  req: Request,
  ctx: WriterForwardContext
): Promise<Response | null> {
  if (requestAlreadyForwarded(req)) return null;
  const publicUrl = ctx.target.writerPublicUrl;
  if (!publicUrl || !ctx.target.writerHubId) return null;
  const timeoutMs = ctx.timeoutMs ?? WRITER_FORWARD_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const src = new URL(req.url);
    const url = joinHubPath(publicUrl, `${src.pathname}${src.search}`);
    const headers = new Headers();
    for (const [name, value] of req.headers.entries()) {
      const key = name.toLowerCase();
      if (HOP_BY_HOP.has(key)) continue;
      if (key === WRITER_FORWARD_HEADER.toLowerCase()) continue;
      if (PASS_THROUGH.has(key) || key.startsWith('x-tmex-')) {
        headers.set(name, value);
      }
    }
    headers.set(WRITER_FORWARD_HEADER, ctx.selfHubId);
    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      signal: ac.signal,
      redirect: 'error',
      duplex: 'half',
    };
    const res = ctx.fetch
      ? await ctx.fetch(url, init)
      : await pinnedFetch(url, init, publicUrl, ctx.hubTrust);
    const outHeaders = new Headers();
    const contentType = res.headers.get('content-type');
    if (contentType) outHeaders.set('content-type', contentType);
    outHeaders.set(WRITER_FORWARD_HEADER, ctx.selfHubId);
    return new Response(res.body, { status: res.status, headers: outHeaders });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pinnedFetch(
  url: string,
  init: RequestInit,
  publicUrl: string,
  hubTrust?: HubTrustStore
): Promise<Response> {
  let pinCa: string | null = null;
  try {
    pinCa = hubTrust?.get(publicUrl)?.caPem ?? null;
  } catch {
    pinCa = null;
  }
  const tls = uplinkWebSocketTls(pinCa ? [pinCa] : null);
  if (tls) Object.assign(init, tls);
  return fetch(url, init);
}
