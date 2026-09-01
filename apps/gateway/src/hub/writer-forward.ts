import { bytesToHex, sha256 } from '@tmex/shared/auth';
import {
  HUB_NOT_WRITER,
  HUB_WRITE_FORWARD_FRAME_MAX_BYTES,
  type HubNotWriterError,
  type HubWriteForwardHeaders,
  type HubWriteForwardMessage,
  TMEX_FORWARDED_BY_HEADER,
  UPLINK_CTL_MAX_BYTES,
  encodeHubUplinkCtl,
} from '@tmex/shared/uplink';
import { json } from '../api/http';

export const WRITER_FORWARD_TIMEOUT_MS = 10_000;
export const WRITER_FORWARD_HEADER = TMEX_FORWARDED_BY_HEADER;
export const WRITE_FORWARD_FRAME_MAX_BYTES = HUB_WRITE_FORWARD_FRAME_MAX_BYTES;
export const WRITE_FORWARD_IDEMPOTENCY_MAX = 256;
export const WRITE_FORWARD_OVERSIZED_ERROR = 'payload_too_large';

const te = new TextEncoder();

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

export function oversizedWriteForwardResponse(): Response {
  return json({ error: WRITE_FORWARD_OVERSIZED_ERROR }, 413);
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

export function writeForwardDigest(msg: HubWriteForwardMessage): string {
  return bytesToHex(
    sha256(
      te.encode(
        JSON.stringify({
          method: msg.method ?? '',
          path: msg.path ?? '',
          headers: msg.headers ?? {},
          body: msg.body ?? '',
          uid: msg.uid ?? '',
        })
      )
    )
  );
}

export function assertWriteForwardEncodedSize(msg: HubWriteForwardMessage): Uint8Array {
  const encoded = encodeHubUplinkCtl(msg);
  if (encoded.byteLength > WRITE_FORWARD_FRAME_MAX_BYTES) {
    throw new Error(
      `hub.write-forward frame ${encoded.byteLength} exceeds ${WRITE_FORWARD_FRAME_MAX_BYTES} (hard ${UPLINK_CTL_MAX_BYTES})`
    );
  }
  return encoded;
}

function writeForwardFits(msg: HubWriteForwardMessage): boolean {
  try {
    assertWriteForwardEncodedSize(msg);
    return true;
  } catch {
    return false;
  }
}

export function chunkWriteForwardAck(ack: HubWriteForwardMessage): HubWriteForwardMessage[] {
  if (writeForwardFits(ack)) return [ack];
  const body = ack.body ?? '';
  const chunks: string[] = [];
  let start = 0;
  while (start < body.length || chunks.length === 0) {
    let lo = 1;
    let hi = Math.max(1, body.length - start);
    let fit = 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const part = chunks.length;
      const candidate: HubWriteForwardMessage = {
        t: 'hub.write-forward',
        id: ack.id,
        ack: true,
        part,
        final: start + mid >= body.length,
        bytes: body.slice(start, start + mid),
      };
      if (part === 0) {
        if (ack.status !== undefined) candidate.status = ack.status;
        if (ack.headers) candidate.headers = ack.headers;
      }
      if (writeForwardFits(candidate)) {
        fit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (fit < 1) {
      throw new Error('hub.write-forward ack chunk cannot fit control frame');
    }
    const part = chunks.length;
    const slice = body.slice(start, start + fit);
    chunks.push(slice);
    start += fit;
    if (start >= body.length) break;
  }
  return chunks.map((bytes, part) => {
    const msg: HubWriteForwardMessage = {
      t: 'hub.write-forward',
      id: ack.id,
      ack: true,
      part,
      final: part === chunks.length - 1,
      bytes,
    };
    if (part === 0) {
      if (ack.status !== undefined) msg.status = ack.status;
      if (ack.headers) msg.headers = ack.headers;
    }
    assertWriteForwardEncodedSize(msg);
    return msg;
  });
}

export class WriteForwardAckAssembler {
  private readonly pending = new Map<
    string,
    { parts: Map<number, string>; status?: number; headers?: HubWriteForwardHeaders }
  >();

  push(msg: HubWriteForwardMessage): HubWriteForwardMessage | null {
    if (!msg.ack || !msg.id) return null;
    if (msg.part === undefined || msg.bytes === undefined) {
      this.pending.delete(msg.id);
      return msg;
    }
    let row = this.pending.get(msg.id);
    if (!row) {
      row = { parts: new Map() };
      this.pending.set(msg.id, row);
    }
    row.parts.set(msg.part, msg.bytes);
    if (msg.status !== undefined) row.status = msg.status;
    if (msg.headers) row.headers = msg.headers;
    if (!msg.final) return null;
    const parts: string[] = [];
    for (let i = 0; i <= msg.part; i++) {
      const chunk = row.parts.get(i);
      if (chunk === undefined) return null;
      parts.push(chunk);
    }
    this.pending.delete(msg.id);
    const assembled: HubWriteForwardMessage = {
      t: 'hub.write-forward',
      id: msg.id,
      ack: true,
      status: row.status ?? 500,
      body: parts.join(''),
    };
    if (row.headers) assembled.headers = row.headers;
    return assembled;
  }

  drop(id: string): void {
    this.pending.delete(id);
  }
}

export class WriteForwardIdempotencyCache {
  private readonly items = new Map<string, { digest: string; ack: HubWriteForwardMessage }>();

  constructor(private readonly max = WRITE_FORWARD_IDEMPOTENCY_MAX) {}

  get(fromHubId: string, id: string): { digest: string; ack: HubWriteForwardMessage } | undefined {
    const key = cacheKey(fromHubId, id);
    const row = this.items.get(key);
    if (!row) return undefined;
    this.items.delete(key);
    this.items.set(key, row);
    return row;
  }

  set(fromHubId: string, id: string, digest: string, ack: HubWriteForwardMessage): void {
    const key = cacheKey(fromHubId, id);
    this.items.delete(key);
    this.items.set(key, { digest, ack });
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }

  get size(): number {
    return this.items.size;
  }
}

function cacheKey(fromHubId: string, id: string): string {
  return `${fromHubId.trim().toLowerCase()}\0${id}`;
}

export async function buildWriteForwardRequest(
  req: Request,
  opts: {
    id: string;
    uid?: string | null;
    writerHubId?: string | null;
    writerEpoch?: number | null;
  }
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
  if (opts.writerHubId) msg.writerHubId = opts.writerHubId;
  if (opts.writerEpoch !== undefined && opts.writerEpoch !== null) {
    msg.writerEpoch = opts.writerEpoch;
  }
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
  const msg = await buildWriteForwardRequest(req, {
    id,
    uid: ctx.uid,
    writerHubId: ctx.target.writerHubId,
    writerEpoch: ctx.target.writerEpoch,
  });
  if (!writeForwardFits(msg)) return oversizedWriteForwardResponse();
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
