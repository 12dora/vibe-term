import { gatewayEventLoopLag } from '../ws/event-loop-lag';
import {
  failoverCauseOf,
  formatFailoverAttempt,
  formatFailoverDone,
  formatFailoverStart,
  formatFailoverSummary,
} from './failover-log';
import {
  type OpenedWsStream,
  type PeerLinkProvider,
  type PeerTransportKind,
  STREAM_FAILOVER_BACKOFF_MS,
  STREAM_FAILOVER_MAX_ATTEMPTS,
  STREAM_FAILOVER_RESUME_WAIT_MS,
  type StreamOpener,
} from './mesh-deps';
import type { StreamReplayState } from './stream-replay-state';

export type ForwardPump = {
  id: string;
  nodeId: string;
  auth: string;
  cid?: string;
  stream: OpenedWsStream | null;
  boundTransport: PeerTransportKind | null;
  replay: StreamReplayState;
  browserClosed: boolean;
  failingOver: boolean;
  failoverAbort: AbortController | null;
  queue: Uint8Array[];
  helloWait: (() => void) | null;
  resumeWait: (() => void) | null;
  streamAlive: boolean;
  inflight: OpenedWsStream | null;
  queueBytes: number;
  lastAttempt?: { attempt: number; getLinkMs: number; openStreamMs: number };
};

export type StreamFailoverHost = {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  log(line: string): void;
  peers: PeerLinkProvider;
  streams: StreamOpener;
  bindStream(pump: ForwardPump, stream: OpenedWsStream, transport: PeerTransportKind | null): void;
  discardStream(pump: ForwardPump, stream: OpenedWsStream): void;
  closeBrowser(pump: ForwardPump, info: { code?: number; reason?: string }): void;
  sendToStream(pump: ForwardPump, stream: OpenedWsStream, bytes: Uint8Array): void;
  flushQueue(pump: ForwardPump): void;
};

function pumpDead(pump: ForwardPump, signal: AbortSignal): boolean {
  return pump.browserClosed || signal.aborted;
}

async function elapsed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await work();
  return { value, ms: Date.now() - t0 };
}

export async function runStreamFailover(
  host: StreamFailoverHost,
  pump: ForwardPump,
  info: { code?: number; reason?: string }
): Promise<void> {
  if (pump.browserClosed || pump.failingOver) return;
  pump.failingOver = true;
  const from = pump.boundTransport ?? 'none';
  const cause = failoverCauseOf(info);
  const startedAt = Date.now();
  const muxStreamId = pump.stream?.muxStreamId ?? null;
  pump.stream = null;
  const abort = new AbortController();
  pump.failoverAbort = abort;
  host.log(
    formatFailoverStart({
      nodeId: pump.nodeId,
      cid: pump.cid,
      pumpId: pump.id,
      muxStreamId,
      cause,
      closeReason: info.reason,
      from,
      linkSinceAt: host.peers.linkSinceAtOf?.(pump.nodeId) ?? null,
      queuedInputBytes: pump.queueBytes,
    })
  );
  try {
    for (let attempt = 0; attempt < STREAM_FAILOVER_MAX_ATTEMPTS; attempt += 1) {
      const opened = await openFailoverStream(host, pump, abort.signal, attempt);
      if (opened === 'aborted') return;
      if (!opened) continue;
      if (
        await completeFailover(
          host,
          pump,
          opened,
          from,
          cause,
          info.reason,
          startedAt,
          abort.signal
        )
      ) {
        return;
      }
    }
    host.closeBrowser(pump, { code: 1011, reason: 'failover-exhausted' });
  } finally {
    if (pump.failingOver) {
      pump.failingOver = false;
      pump.failoverAbort = null;
    }
  }
}

async function openFailoverStream(
  host: StreamFailoverHost,
  pump: ForwardPump,
  signal: AbortSignal,
  attempt: number
): Promise<OpenedWsStream | null | 'aborted'> {
  if (pumpDead(pump, signal)) return 'aborted';
  const delay = STREAM_FAILOVER_BACKOFF_MS[attempt] ?? 1600;
  if (delay > 0) {
    try {
      await host.sleep(delay, signal);
    } catch {
      return 'aborted';
    }
  }
  if (pumpDead(pump, signal)) return 'aborted';
  const linked = await elapsed(() => host.peers.getLink(pump.nodeId).catch(() => null));
  if (pumpDead(pump, signal)) return 'aborted';
  const link = linked.value;
  if (!link) {
    host.log(
      formatFailoverAttempt({
        pumpId: pump.id,
        attempt: attempt + 1,
        getLinkMs: linked.ms,
        openStreamMs: 0,
        helloWaitMs: 0,
        resumeWaitMs: 0,
      })
    );
    return null;
  }
  const transport = host.peers.transportOf?.(pump.nodeId) ?? null;
  const opened = await elapsed(() =>
    host.streams.openWsStream(link, pump.auth, pump.cid).catch(() => null)
  );
  const stream = opened.value;
  if (!stream) {
    host.log(
      formatFailoverAttempt({
        pumpId: pump.id,
        attempt: attempt + 1,
        getLinkMs: linked.ms,
        openStreamMs: opened.ms,
        helloWaitMs: 0,
        resumeWaitMs: 0,
      })
    );
    return pumpDead(pump, signal) ? 'aborted' : null;
  }
  pump.inflight = stream;
  if (pumpDead(pump, signal)) {
    host.discardStream(pump, stream);
    return 'aborted';
  }
  host.bindStream(pump, stream, transport);
  pump.inflight = null;
  pump.lastAttempt = {
    attempt: attempt + 1,
    getLinkMs: linked.ms,
    openStreamMs: opened.ms,
  };
  return stream;
}

async function completeFailover(
  host: StreamFailoverHost,
  pump: ForwardPump,
  stream: OpenedWsStream,
  from: string,
  cause: ReturnType<typeof failoverCauseOf>,
  closeReason: string | undefined,
  startedAt: number,
  signal: AbortSignal
): Promise<boolean> {
  const waits = await replaySubscription(host, pump, stream, signal);
  host.log(
    formatFailoverAttempt({
      pumpId: pump.id,
      attempt: pump.lastAttempt?.attempt ?? 1,
      getLinkMs: pump.lastAttempt?.getLinkMs ?? 0,
      openStreamMs: pump.lastAttempt?.openStreamMs ?? 0,
      helloWaitMs: waits.helloWaitMs,
      resumeWaitMs: waits.resumeWaitMs,
    })
  );
  if (pumpDead(pump, signal)) {
    host.discardStream(pump, stream);
    return true;
  }
  if (!pump.streamAlive || pump.stream !== stream) return false;
  const resumed = pump.replay.resumedPaneCount();
  const desc = pump.replay.describeReplay();
  const replayBytes = pump.replay.legacyReplayStats().replayBytes;
  const durationMs = Date.now() - startedAt;
  const to = pump.boundTransport ?? 'none';
  const lag = gatewayEventLoopLag().snapshot();
  host.log(
    `[mesh][stream] failover stream=${pump.id} from=${from} to=${to} resumed=${resumed} mode=${desc.mode} panes=${desc.panes} cursor=${desc.cursor}`
  );
  host.log(
    formatFailoverDone({
      pumpId: pump.id,
      durationMs,
      to,
      resumed,
      replayMode: desc.mode,
      replayBytes,
    })
  );
  host.log(
    formatFailoverSummary({
      pumpId: pump.id,
      durationMs,
      cause,
      closeReason,
      from,
      to,
      replayBytes,
      eventLoopLagMs: lag.lagMs,
      maxLagMs: lag.maxLagMs,
    })
  );
  pump.failingOver = false;
  pump.failoverAbort = null;
  host.flushQueue(pump);
  return true;
}

async function replaySubscription(
  host: StreamFailoverHost,
  pump: ForwardPump,
  stream: OpenedWsStream,
  signal: AbortSignal
): Promise<{ helloWaitMs: number; resumeWaitMs: number; resumed: number }> {
  pump.replay.beginResume();
  const wait = async (key: 'helloWait' | 'resumeWait', ms: number, before?: () => void) => {
    const t0 = Date.now();
    const waited = new Promise<void>((resolve) => {
      pump[key] = resolve;
    });
    before?.();
    await Promise.race([waited, host.sleep(ms, signal).catch(() => undefined)]);
    pump[key] = null;
    return Date.now() - t0;
  };
  let helloWaitMs = 0;
  let resumeWaitMs = 0;
  const hello = pump.replay.hello;
  if (hello)
    helloWaitMs = await wait('helloWait', 2_000, () => host.sendToStream(pump, stream, hello));
  const sendAll = (frames: Uint8Array[]): void => {
    for (const frame of frames) {
      if (pumpDead(pump, signal)) return;
      host.sendToStream(pump, stream, frame);
    }
  };
  sendAll(pump.replay.buildConnectFrames());
  if (pump.replay.devices.size > 0 && !pump.replay.isResumeReady()) {
    resumeWaitMs = await wait('resumeWait', STREAM_FAILOVER_RESUME_WAIT_MS);
  }
  sendAll(pump.replay.buildPostConnectFrames());
  if (!pumpDead(pump, signal)) pump.replay.markCanonicalResumeSent();
  return { helloWaitMs, resumeWaitMs, resumed: pump.replay.resumedPaneCount() };
}
