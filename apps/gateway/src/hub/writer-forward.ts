import {
  HUB_NOT_WRITER,
  type HubNotWriterError,
  type HubWriteForwardHeaders,
  type HubWriteForwardMessage,
  TMEX_FORWARDED_BY_HEADER,
} from '@tmex/shared/uplink';
import { json } from '../api/http';

export const WRITER_FORWARD_TIMEOUT_MS = 10_000;
export const WRITER_FORWARD_HEADER = TMEX_FORWARDED_BY_HEADER;

export type WriterForwardTarget = {
  writerHubId: string | null;
  writerPublicUrl: string | null;
  writerEpoch: number | null;
};

export type WriterForwardSend = (msg: HubWriteForwardMessage) => void;

export type WriterForwardContext = {
  selfHubId: string;
  uid?: string | null;
  target: WriterForwardTarget;
  send?: WriterForwardSend;
  waitAck?: (id: string) => Promise<HubWriteForwardMessage | null>;
  isLive?: () => boolean;
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

export function collectWriteForwardHeaders(req: Request): HubWriteForwardHeaders | undefined {
  const headers: HubWriteForwardHeaders = {};
  const contentType = req.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  const force = req.headers.get('x-tmex-force-keylog');
  if (force) headers['x-tmex-force-keylog'] = force;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function ackToHttpResponse(msg: HubWriteForwardMessage, forwardedBy: string): Response {
  const headers = new Headers();
  const contentType = msg.headers?.['content-type'];
  if (contentType) headers.set('content-type', contentType);
  headers.set(WRITER_FORWARD_HEADER, forwardedBy);
  return new Response(msg.body ?? null, { status: msg.status ?? 500, headers });
}

export async function buildWriteForwardRequest(
  req: Request,
  opts: { id: string; uid?: string | null }
): Promise<HubWriteForwardMessage> {
  const src = new URL(req.url);
  const msg: HubWriteForwardMessage = {
    t: 'hub.write-forward',
    id: opts.id,
    method: req.method,
    path: `${src.pathname}${src.search}`,
  };
  const headers = collectWriteForwardHeaders(req);
  if (headers) msg.headers = headers;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    msg.body = await req.text();
  }
  if (opts.uid) msg.uid = opts.uid;
  return msg;
}

export async function forwardWriteToWriter(
  req: Request,
  ctx: WriterForwardContext
): Promise<Response | null> {
  if (requestAlreadyForwarded(req)) return null;
  if (!ctx.target.writerHubId) return null;
  if (!ctx.isLive?.() || !ctx.send || !ctx.waitAck) return null;
  const timeoutMs = ctx.timeoutMs ?? WRITER_FORWARD_TIMEOUT_MS;
  const id = crypto.randomUUID();
  const msg = await buildWriteForwardRequest(req, { id, uid: ctx.uid });
  try {
    ctx.send(msg);
  } catch {
    return null;
  }
  const ack = await Promise.race([
    ctx.waitAck(id),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (!ack?.ack) return null;
  return ackToHttpResponse(ack, ctx.selfHubId);
}
