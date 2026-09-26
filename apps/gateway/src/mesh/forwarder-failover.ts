import type { LinkSession } from '@vibeterm/shared/link';
import { DEFAULT_DIAL_RTT_MS, adaptiveDeadlineMs, nestedDialBudgetsMs } from '@vibeterm/shared/net';
import { gatewayEventLoopLag } from '../ws/event-loop-lag';
import {
  failoverCauseOf,
  formatFailoverAttempt,
  formatFailoverDone,
  formatFailoverStart,
  formatFailoverSummary,
} from './failover-log';
import {
  type FailoverLinkPick,
  openedLinkTransport,
  pickFailoverLink,
} from './forwarder-failover-link';
import {
  STREAM_STALE_INPUT_TTL_MS,
  type StaleQueueDrop,
  dropStaleQueuedInput,
  streamStaleInputTtlMs,
} from './forwarder-failover-stale';

export { STREAM_STALE_INPUT_TTL_MS, dropStaleQueuedInput, streamStaleInputTtlMs };
export type { StaleQueueDrop };
import { forgetQueuedHello, queuedHello, waitForFirstInbound } from './forwarder-failover-hello';
import {
  type OpenedWsStream,
  type PeerLinkProvider,
  type PeerTransportKind,
  STREAM_FAILOVER_BACKOFF_MS,
  STREAM_FAILOVER_MAX_ATTEMPTS,
  STREAM_FAILOVER_RESUME_WAIT_MS,
  type StreamOpener,
} from './mesh-deps';
import { PENDING_MEASURE_REASON, emitTransportRefused } from './pending-measure-hold';
import { type StreamReplayState, rejectStaleNodeStream } from './stream-replay-state';

export type ForwardPump = {
  id: string;
  nodeId: string;
  auth: string;
  cid?: string;
  /** 分享页握手的 shareId：failover 重开流时必须原样带上。 */
  share?: string;
  stream: OpenedWsStream | null;
  boundTransport: PeerTransportKind | null;
  replay: StreamReplayState;
  browserClosed: boolean;
  failingOver: boolean;
  failoverAbort: AbortController | null;
  queue: Uint8Array[];
  /** 与 queue 一一对应的入队时刻，用于 failover 恢复时丢弃过期输入。 */
  queuedAt: number[];
  helloWait: (() => void) | null;
  resumeWait: (() => void) | null;
  streamAlive: boolean;
  inflight: OpenedWsStream | null;
  queueBytes: number;
  lastAttempt?: { attempt: number; getLinkMs: number; openStreamMs: number };
  /** 这条泵上，入站第一帧出现之前连续死去的开流次数。看到入站帧才清零。 */
  deadOpens: number;
  sawInbound: boolean;
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

/** 首次续流等 HELLO 的下限。 */
export const STREAM_FAILOVER_HELLO_WAIT_MS = 2_000;
/** 连续无 HELLO 回应时，后续续流等待的下限。 */
export const STREAM_FAILOVER_HELLO_RETRY_WAIT_MS = 500;
/** 连续这么多轮拿不到 HELLO 就不再静默重试，直接把这条转发流收掉让浏览器重连。 */
export const STREAM_FAILOVER_NO_HELLO_LIMIT = 3;

function noteDirectMeasureRefusal(pump: ForwardPump): void {
  if (pump.boundTransport !== 'dc' && pump.boundTransport !== 'ws-secure') return;
  emitTransportRefused(pump.nodeId, null);
}

function peerRttMs(host: StreamFailoverHost, pump: ForwardPump): number {
  const rtt = host.peers.rttOf?.(pump.nodeId);
  return typeof rtt === 'number' && Number.isFinite(rtt) && rtt > 0 ? rtt : DEFAULT_DIAL_RTT_MS;
}

function helloWaitBudgetMs(rttMs: number, retry: boolean): number {
  return adaptiveDeadlineMs({
    rttMs,
    factor: retry ? 2 : 4,
    minMs: retry ? STREAM_FAILOVER_HELLO_RETRY_WAIT_MS : STREAM_FAILOVER_HELLO_WAIT_MS,
    maxMs: retry ? 4_000 : 8_000,
  });
}

/** 一轮续流的结果：done = 不再重试；retry = 换一条再来；retry-no-hello = 对端一声没吭。 */
type FailoverAttemptOutcome = 'done' | 'retry' | 'retry-no-hello';

type FailoverAttemptContext = {
  from: string;
  cause: ReturnType<typeof failoverCauseOf>;
  closeReason: string | undefined;
  startedAt: number;
  signal: AbortSignal;
  helloWaitMs: number;
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
  if (info.reason === PENDING_MEASURE_REASON) noteDirectMeasureRefusal(pump);
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
    const result = await runFailoverAttempts(host, pump, {
      from,
      cause,
      closeReason: info.reason,
      startedAt,
      signal: abort.signal,
    });
    if (result === 'settled') return;
    host.closePump(pump, {
      code: 1011,
      reason: result === 'no-hello' ? 'failover-no-hello' : 'failover-exhausted',
    });
  } catch {
    if (!pump.browserClosed) host.closePump(pump, { code: 1011, reason: 'failover-error' });
  } finally {
    if (pump.failingOver) {
      pump.failingOver = false;
      pump.failoverAbort = null;
    }
  }
}

/**
 * 逐轮续流。连续 `STREAM_FAILOVER_NO_HELLO_LIMIT` 轮拿不到 HELLO 就收手：对端一声不吭时
 * 把 9 轮退避加上每轮 HELLO 等待全走完要 30 s 上下，浏览器白等还不如早点断开重连。
 * 答过 HELLO 的那一轮把计数清零，正常的链路切换仍然享有完整重试预算。
 */
async function runFailoverAttempts(
  host: StreamFailoverHost,
  pump: ForwardPump,
  base: Omit<FailoverAttemptContext, 'helloWaitMs'>
): Promise<'settled' | 'exhausted' | 'no-hello'> {
  for (let attempt = 0; attempt < STREAM_FAILOVER_MAX_ATTEMPTS; attempt += 1) {
    const opened = await openFailoverStream(host, pump, base.signal, attempt);
    if (opened === 'aborted') return 'settled';
    if (opened === 'terminal') {
      host.closePump(pump, { code: 1011, reason: 'node-unreachable' });
      return 'settled';
    }
    if (!opened) continue;
    const helloWaitMs = helloWaitBudgetMs(peerRttMs(host, pump), pump.deadOpens > 0);
    const outcome = await completeFailover(host, pump, opened, { ...base, helloWaitMs });
    if (outcome === 'done') return 'settled';
    if (outcome !== 'retry-no-hello') {
      pump.deadOpens = 0;
      continue;
    }
    pump.deadOpens += 1;
    if (pump.deadOpens >= STREAM_FAILOVER_NO_HELLO_LIMIT) return 'no-hello';
  }
  return 'exhausted';
}

async function openFailoverStream(
  host: StreamFailoverHost,
  pump: ForwardPump,
  signal: AbortSignal,
  attempt: number
): Promise<OpenedWsStream | null | 'aborted' | 'terminal'> {
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
  const picked = await elapsed(() =>
    pickFailoverLink(host.peers, pump.nodeId, signal, pumpDead(pump, signal))
  );
  return attachPickedStream(host, pump, signal, {
    attempt: attempt + 1,
    value: picked.value,
    getLinkMs: picked.ms,
  });
}

async function attachPickedStream(
  host: StreamFailoverHost,
  pump: ForwardPump,
  signal: AbortSignal,
  picked: { attempt: number; value: FailoverLinkPick; getLinkMs: number }
): Promise<OpenedWsStream | null | 'aborted' | 'terminal'> {
  const link = picked.value;
  if (link === 'aborted' || pumpDead(pump, signal)) return 'aborted';
  if (link === 'terminal') return 'terminal';
  if (!link) {
    logFailoverMiss(host, pump, picked.attempt, picked.getLinkMs, 0);
    return null;
  }
  const transport = openedLinkTransport(host.peers, pump.nodeId, link);
  const opened = await elapsed(() =>
    host.streams.openWsStream(link, pump.auth, pump.cid, pump.share).catch(() => null)
  );
  const stream = opened.value;
  if (!stream) {
    logFailoverMiss(host, pump, picked.attempt, picked.getLinkMs, opened.ms);
    return pumpDead(pump, signal) ? 'aborted' : null;
  }
  pump.inflight = stream;
  if (pumpDead(pump, signal)) {
    host.discardStream(pump, stream);
    return 'aborted';
  }
  pump.sawInbound = false;
  host.bindStream(pump, stream, transport);
  pump.inflight = null;
  pump.lastAttempt = {
    attempt: picked.attempt,
    getLinkMs: picked.getLinkMs,
    openStreamMs: opened.ms,
  };
  return stream;
}

function logFailoverMiss(
  host: StreamFailoverHost,
  pump: ForwardPump,
  attempt: number,
  getLinkMs: number,
  openStreamMs: number
): void {
  safeLog(
    host,
    formatFailoverAttempt({
      pumpId: pump.id,
      attempt,
      getLinkMs,
      openStreamMs,
      helloWaitMs: 0,
      resumeWaitMs: 0,
    })
  );
}

async function completeFailover(
  host: StreamFailoverHost,
  pump: ForwardPump,
  stream: OpenedWsStream,
  ctx: FailoverAttemptContext
): Promise<FailoverAttemptOutcome> {
  const { from, cause, closeReason, startedAt, signal } = ctx;
  const waits = await replaySubscription(host, pump, stream, signal, ctx.helloWaitMs);
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
    return 'done';
  }
  if (!waits.helloOk) {
    // HELLO 压根没回来（新流在握手前就被拆了，如链路又抖、或撞上目标那边还没退场的同 cid 连接）：
    // 这是链路问题，换一条继续重试；当成「节点版本太旧」把浏览器关掉是误判。
    if (!waits.helloReplied) {
      host.discardStream(pump, stream);
      return 'retry-no-hello';
    }
    // 对端确实答了 HELLO 但版本不达标：不能盲续（订阅、队列都会打到一条身份未知的流上）。
    rejectStaleNodeStream(true, pump, {
      log: (line) => safeLog(host, line),
      sendToBrowser: (target, bytes) => host.sendToBrowser(target, bytes),
      closePump: (target, closeInfo) => host.closePump(target, closeInfo),
    });
    return 'done';
  }
  // 这条流不再是要续的那条（已断 / 已被新流顶掉）：放弃它之前先关掉，别留给下一轮。
  if (!pump.streamAlive || pump.stream !== stream) {
    host.discardStream(pump, stream);
    return 'retry';
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
  const budgetMs = nestedDialBudgetsMs(peerRttMs(host, pump)).forwardMs;
  const stale = dropStaleQueuedInput(pump, Date.now(), streamStaleInputTtlMs(budgetMs));
  if (stale.droppedFrames > 0) {
    safeLog(
      host,
      `[mesh][stream] dropped stale queued input bytes=${stale.droppedBytes} age_ms=${stale.oldestAgeMs}`
    );
  }
  host.flushQueue(pump);
  for (const frame of pump.replay.browserSignalFrames()) {
    host.sendToBrowser(pump, frame);
  }
  return 'done';
}

type ReplayWait = {
  helloWaitMs: number;
  resumeWaitMs: number;
  resumed: number;
  helloOk: boolean;
  helloReplied: boolean;
};

async function replaySubscription(
  host: StreamFailoverHost,
  pump: ForwardPump,
  stream: OpenedWsStream,
  signal: AbortSignal,
  helloWaitBudgetMs: number
): Promise<ReplayWait> {
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
  let hello = queuedHello(pump);
  if (!hello) {
    const first = await waitForFirstInbound(pump, stream, signal, helloWaitBudgetMs, wait);
    if (!('upgradeHello' in first)) return first;
    hello = first.upgradeHello;
  }
  forgetQueuedHello(pump);
  helloWaitMs = await wait('helloWait', helloWaitBudgetMs, () =>
    host.sendToStream(pump, stream, hello)
  );
  // beginResume 已把 peerVersion 清空：这里为真只可能是本条流刚播报了达标版本。
  if (!pump.replay.peerSupportsCanonical()) {
    return {
      helloWaitMs,
      resumeWaitMs,
      resumed: 0,
      helloOk: false,
      helloReplied: pump.replay.resumeHelloSeen,
    };
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
  return {
    helloWaitMs,
    resumeWaitMs,
    resumed: pump.replay.resumedPaneCount(),
    helloOk: true,
    helloReplied: pump.replay.resumeHelloSeen,
  };
}
