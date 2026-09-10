import { wsBorsh } from '@vibeterm/shared';
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

/** 与前端 `STALE_INPUT_TTL_MS` 同值：failover 期间排队超过它的终端输入不再补发。 */
export const STREAM_STALE_INPUT_TTL_MS = 10_000;

/** 首次续流等 HELLO 的上限；对端只是慢，值给得宽一点。 */
export const STREAM_FAILOVER_HELLO_WAIT_MS = 2_000;
/** 已经有一轮一个字节都没答上来：后续每轮只等这么久，别把浏览器晾在那里。 */
export const STREAM_FAILOVER_HELLO_RETRY_WAIT_MS = 500;
/** 连续这么多轮拿不到 HELLO 就不再静默重试，直接把这条转发流收掉让浏览器重连。 */
export const STREAM_FAILOVER_NO_HELLO_LIMIT = 3;

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

/** 队列里是不透明的 mux 帧，只能解信封判定；解不出的一律当结构帧保留。 */
function isOrderedInputFrame(bytes: Uint8Array): boolean {
  let env: wsBorsh.Envelope;
  try {
    env = wsBorsh.decodeEnvelopeView(bytes);
  } catch {
    return false;
  }
  if (env.kind === wsBorsh.KIND_TERM_INPUT || env.kind === wsBorsh.KIND_TERM_PASTE) return true;
  if (env.kind !== wsBorsh.KIND_CANONICAL_COMMAND) return false;
  try {
    return 'TerminalInput' in wsBorsh.decodeCanonicalCommandPayload(env.payload).command;
  } catch {
    return false;
  }
}

export type StaleQueueDrop = { droppedFrames: number; droppedBytes: number; oldestAgeMs: number };

/**
 * failover 恢复后不再补发排队过久的终端输入：用户对着卡住的终端敲的 `exit` / Ctrl-D
 * 几十秒后落到已恢复的 pane 会杀掉里面的进程。只丢输入帧，结构帧（订阅、连接、resize）照旧。
 */
export function dropStaleQueuedInput(
  pump: Pick<ForwardPump, 'queue' | 'queuedAt' | 'queueBytes'>,
  now: number,
  ttlMs: number = STREAM_STALE_INPUT_TTL_MS
): StaleQueueDrop {
  const keptFrames: Uint8Array[] = [];
  const keptAt: number[] = [];
  let droppedFrames = 0;
  let droppedBytes = 0;
  let oldestAgeMs = 0;
  for (let index = 0; index < pump.queue.length; index += 1) {
    const bytes = pump.queue[index];
    const age = now - (pump.queuedAt[index] ?? now);
    if (age > ttlMs && isOrderedInputFrame(bytes)) {
      droppedFrames += 1;
      droppedBytes += bytes.byteLength;
      oldestAgeMs = Math.max(oldestAgeMs, age);
      continue;
    }
    keptFrames.push(bytes);
    keptAt.push(pump.queuedAt[index] ?? now);
  }
  if (droppedFrames > 0) {
    pump.queue.length = 0;
    pump.queue.push(...keptFrames);
    pump.queuedAt.length = 0;
    pump.queuedAt.push(...keptAt);
    pump.queueBytes = Math.max(0, pump.queueBytes - droppedBytes);
  }
  return { droppedFrames, droppedBytes, oldestAgeMs };
}

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
  let noHelloStreak = 0;
  for (let attempt = 0; attempt < STREAM_FAILOVER_MAX_ATTEMPTS; attempt += 1) {
    const opened = await openFailoverStream(host, pump, base.signal, attempt);
    if (opened === 'aborted') return 'settled';
    if (!opened) continue;
    const helloWaitMs =
      noHelloStreak === 0 ? STREAM_FAILOVER_HELLO_WAIT_MS : STREAM_FAILOVER_HELLO_RETRY_WAIT_MS;
    const outcome = await completeFailover(host, pump, opened, { ...base, helloWaitMs });
    if (outcome === 'done') return 'settled';
    if (outcome !== 'retry-no-hello') {
      noHelloStreak = 0;
      continue;
    }
    noHelloStreak += 1;
    if (noHelloStreak >= STREAM_FAILOVER_NO_HELLO_LIMIT) return 'no-hello';
  }
  return 'exhausted';
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
    host.streams.openWsStream(link, pump.auth, pump.cid, pump.share).catch(() => null)
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
  const stale = dropStaleQueuedInput(pump, Date.now());
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

async function replaySubscription(
  host: StreamFailoverHost,
  pump: ForwardPump,
  stream: OpenedWsStream,
  signal: AbortSignal,
  helloWaitBudgetMs: number
): Promise<{
  helloWaitMs: number;
  resumeWaitMs: number;
  resumed: number;
  helloOk: boolean;
  helloReplied: boolean;
}> {
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
