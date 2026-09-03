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
import { type StreamReplayState, rejectStaleNodeStream } from './stream-replay-state';

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
  /** 整条拆解（上游流 + 在途流 + 浏览器）：failover 的所有终止路径都走它。 */
  closePump(pump: ForwardPump, info: { code?: number; reason?: string }): void;
  sendToStream(pump: ForwardPump, stream: OpenedWsStream, bytes: Uint8Array): void;
  sendToBrowser(pump: ForwardPump, bytes: Uint8Array): void;
  flushQueue(pump: ForwardPump): void;
};

function safeLog(host: StreamFailoverHost, line: string): void {
  try {
    host.log(line);
  } catch {
    // diagnostic logging must never break the failover state machine
  }
}

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
  const abort = new AbortController();
  pump.failingOver = true;
  pump.failoverAbort = abort;
  try {
    const from = pump.boundTransport ?? 'none';
    const cause = failoverCauseOf(info);
    const startedAt = Date.now();
    const muxStreamId = pump.stream?.muxStreamId ?? null;
    pump.stream = null;
    safeLog(
      host,
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
    host.closePump(pump, { code: 1011, reason: 'failover-exhausted' });
  } catch {
    if (!pump.browserClosed) host.closePump(pump, { code: 1011, reason: 'failover-error' });
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
    safeLog(
      host,
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
    safeLog(
      host,
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
  safeLog(
    host,
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
  // 新流没答 HELLO / 答的 HELLO 解不出版本：不能盲续（订阅、队列都会打到一条身份未知的流上）。
  if (!waits.helloOk) {
    rejectStaleNodeStream(true, pump, {
      log: (line) => safeLog(host, line),
      sendToBrowser: (target, bytes) => host.sendToBrowser(target, bytes),
      closePump: (target, closeInfo) => host.closePump(target, closeInfo),
    });
    return true;
  }
  // 这条流不再是要续的那条（已断 / 已被新流顶掉）：放弃它之前先关掉，别留给下一轮。
  if (!pump.streamAlive || pump.stream !== stream) {
    host.discardStream(pump, stream);
    return false;
  }
  const resumed = pump.replay.resumedPaneCount();
  const desc = pump.replay.describeReplay();
  const durationMs = Date.now() - startedAt;
  const to = pump.boundTransport ?? 'none';
  let lag = { lagMs: 0, maxLagMs: 0 };
  try {
    lag = gatewayEventLoopLag().snapshot();
  } catch {
    lag = { lagMs: 0, maxLagMs: 0 };
  }
  safeLog(
    host,
    `[mesh][stream] failover stream=${pump.id} from=${from} to=${to} resumed=${resumed} mode=${desc.mode} panes=${desc.panes} cursor=${desc.cursor}`
  );
  safeLog(
    host,
    formatFailoverDone({
      pumpId: pump.id,
      durationMs,
      to,
      resumed,
      replayMode: desc.mode,
    })
  );
  safeLog(
    host,
    formatFailoverSummary({
      pumpId: pump.id,
      durationMs,
      cause,
      closeReason,
      from,
      to,
      eventLoopLagMs: lag.lagMs,
      maxLagMs: lag.maxLagMs,
    })
  );
  pump.failingOver = false;
  pump.failoverAbort = null;
  host.flushQueue(pump);
  for (const frame of pump.replay.browserSignalFrames()) {
    host.sendToBrowser(pump, frame);
  }
  return true;
}

async function replaySubscription(
  host: StreamFailoverHost,
  pump: ForwardPump,
  stream: OpenedWsStream,
  signal: AbortSignal
): Promise<{ helloWaitMs: number; resumeWaitMs: number; resumed: number; helloOk: boolean }> {
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
  if (hello) {
    helloWaitMs = await wait('helloWait', 2_000, () => host.sendToStream(pump, stream, hello));
    // beginResume 已把 peerVersion 清空：这里为真只可能是本条流刚播报了达标版本。
    if (!pump.replay.peerSupportsCanonical()) {
      return { helloWaitMs, resumeWaitMs, resumed: 0, helloOk: false };
    }
  }
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
  return { helloWaitMs, resumeWaitMs, resumed: pump.replay.resumedPaneCount(), helloOk: true };
}
