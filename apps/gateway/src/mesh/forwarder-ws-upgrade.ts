import type { LinkSession } from '@vibeterm/shared/link';
import { nodeUnreachableResponse } from './forwarder-unreachable';
import { rejectRemoteWs, remoteWsAuthFor } from './forwarder-ws-auth';
import {
  MESH_FORWARD_WS_KIND,
  type MeshUpgradeServer,
  type OpenedWsStream,
  type PeerLinkProvider,
  type PeerTransportKind,
  type StreamOpener,
} from './mesh-deps';
import { sanitizeCid } from './mesh-session-registry';
import { jsonError } from './session-middleware';
import { shareWsParam } from './share-credential';

/** getLink 失败在 101 之后关掉浏览器：与 4401 登录失效区分（KI-12）。 */
export const FORWARD_WS_LINK_FAILURE_CODE = 1011;
export const FORWARD_WS_LINK_FAILURE_REASON = 'node-unreachable';
export const FORWARD_WS_LINK_TIMEOUT_REASON = 'forward-link-timeout';

export function forwardWsLinkFailureReason(err: unknown): string {
  if (err instanceof Error && err.message === 'forward-link-timeout') {
    return FORWARD_WS_LINK_TIMEOUT_REASON;
  }
  if (err instanceof DOMException && err.name === 'AbortError') return 'aborted';
  return FORWARD_WS_LINK_FAILURE_REASON;
}

export class PendingForwardOpen {
  readonly abort = new AbortController();
  private opened: OpenedWsStream | null = null;
  private failReason: string | null = null;
  private readyCb: ((stream: OpenedWsStream) => void) | null = null;
  private failCb: ((reason: string) => void) | null = null;

  constructor(start: (signal: AbortSignal) => Promise<OpenedWsStream>) {
    void start(this.abort.signal).then(
      (stream) => {
        if (this.failReason) {
          stream.close();
          return;
        }
        this.opened = stream;
        this.readyCb?.(stream);
      },
      (err) => {
        if (this.failReason) return;
        this.failReason = forwardWsLinkFailureReason(err);
        this.failCb?.(this.failReason);
      }
    );
  }

  attach(onReady: (stream: OpenedWsStream) => void, onFail: (reason: string) => void): void {
    this.readyCb = onReady;
    this.failCb = onFail;
    if (this.opened) onReady(this.opened);
    else if (this.failReason) onFail(this.failReason);
  }

  matches(stream: OpenedWsStream | PendingForwardOpen): boolean {
    return stream === this || stream === this.opened;
  }

  close(code?: number, reason?: string): void {
    this.failReason ??= reason ?? 'aborted';
    this.abort.abort();
    this.opened?.close(code, reason);
  }
}

type WsDeps = { peers: PeerLinkProvider; streams: StreamOpener; deadlineMs: number };

export async function upgradeRemoteWs(
  req: Request,
  server: MeshUpgradeServer,
  nodeId: string,
  deps: WsDeps
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const share = shareWsParam(url);
  const auth = remoteWsAuthFor(req, nodeId, share);
  if (!auth) return rejectRemoteWs(req, server, nodeId, share);
  if (req.signal.aborted) return nodeUnreachableResponse(nodeId, true);
  const cid = sanitizeCid(url.searchParams.get('cid')) || undefined;
  const pending = new PendingForwardOpen((signal) =>
    openForwardLink(nodeId, deps, auth, cid, share ?? undefined, signal)
  );
  if (req.signal.aborted) pending.abort.abort();
  else req.signal.addEventListener('abort', () => pending.abort.abort(), { once: true });
  const token = crypto.randomUUID();
  pendingStreams.set(token, pending);
  pendingMeta.set(pending, {
    nodeId,
    auth,
    cid,
    ...(share ? { share } : {}),
    transport: deps.peers.transportOf?.(nodeId) ?? null,
  });
  if (!server.upgrade(req, { data: { kind: MESH_FORWARD_WS_KIND, nodeId, auth, token, cid } })) {
    pendingStreams.delete(token);
    pending.close();
    return jsonError('upgrade_failed', 500);
  }
  armPendingExpiry(token, pending);
  return undefined;
}

async function openForwardLink(
  nodeId: string,
  deps: WsDeps,
  auth: string,
  cid: string | undefined,
  share: string | undefined,
  signal: AbortSignal
): Promise<OpenedWsStream> {
  const link = await raceLink(deps.peers.getLink(nodeId), deps.deadlineMs, signal);
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  return deps.streams.openWsStream(link, auth, cid, share);
}

function raceLink(
  getLink: Promise<LinkSession>,
  deadlineMs: number,
  signal: AbortSignal
): Promise<LinkSession> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), Math.max(0, deadlineMs));
  timer.unref?.();
  return new Promise<LinkSession>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onParent);
      fn();
    };
    const fail = (): void => {
      void getLink.catch(() => undefined);
      if (signal.aborted) {
        done(() => reject(new DOMException('The operation was aborted.', 'AbortError')));
        return;
      }
      done(() => reject(new Error('forward-link-timeout')));
    };
    const onParent = (): void => timeout.abort();
    timeout.signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted || deadlineMs <= 0) timeout.abort();
    else signal.addEventListener('abort', onParent, { once: true });
    getLink.then(
      (link) => done(() => resolve(link)),
      (err) => done(() => reject(err))
    );
  });
}

export const DEFAULT_PENDING_FORWARD_STREAM_TTL_MS = 60_000;
let pendingForwardStreamTtlMs = DEFAULT_PENDING_FORWARD_STREAM_TTL_MS;
const pendingStreams = new Map<string, PendingForwardOpen>();
const pendingExpiry = new Map<string, ReturnType<typeof setTimeout>>();
export const pendingMeta = new WeakMap<
  object,
  {
    nodeId: string;
    auth: string;
    cid?: string;
    share?: string;
    transport: PeerTransportKind | null;
  }
>();

export function setPendingForwardStreamTtlMs(ms: number): void {
  pendingForwardStreamTtlMs = ms;
}

export function pendingForwardStreamCount(): number {
  return pendingStreams.size;
}

export function takePendingForwardStream(
  token: string | undefined
): PendingForwardOpen | undefined {
  if (!token) return undefined;
  const pending = pendingStreams.get(token);
  if (!pending) return undefined;
  pendingStreams.delete(token);
  clearPendingExpiry(token);
  return pending;
}

export function expirePendingForwardStream(
  token: string,
  stream: OpenedWsStream | PendingForwardOpen
): void {
  const pending = pendingStreams.get(token);
  if (!pending || !pending.matches(stream)) return;
  pendingStreams.delete(token);
  clearPendingExpiry(token);
  pending.close();
}

function clearPendingExpiry(token: string): void {
  const timer = pendingExpiry.get(token);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingExpiry.delete(token);
}

function armPendingExpiry(token: string, pending: PendingForwardOpen): void {
  const timer = setTimeout(
    () => expirePendingForwardStream(token, pending),
    pendingForwardStreamTtlMs
  );
  timer.unref?.();
  pendingExpiry.set(token, timer);
}

export function discardPendingStream(token: string | undefined): void {
  if (!token) return;
  const pending = pendingStreams.get(token);
  if (!pending) return;
  pendingStreams.delete(token);
  clearPendingExpiry(token);
  pending.close();
}
