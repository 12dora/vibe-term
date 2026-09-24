import type { OpenedWsStream } from './mesh-deps';

type HoldPump = {
  stream: OpenedWsStream | null;
  streamAlive: boolean;
  browserClosed: boolean;
  helloWait: (() => void) | null;
};

/** 同一传输上，ack 之前被拆掉只允许再试一次，避免 delay 0 的热循环。 */
export const SAME_TRANSPORT_PRE_ACK_RETRIES = 1;

/**
 * 没有 HELLO 可等时，流至少要活过一个 RTT，才能把这次 failover 算成功。
 * 封顶 250 ms：健康的无订阅流转发不必干等整段 HELLO 预算。
 */
export function unackedOpenHoldMs(rttMs: number): number {
  const rtt = Number.isFinite(rttMs) && rttMs > 0 ? rttMs : 50;
  return Math.min(Math.max(rtt, 50), 250);
}

type HoldHost = {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export async function waitUnackedOpen(
  host: HoldHost,
  pump: HoldPump,
  stream: OpenedWsStream,
  signal: AbortSignal,
  holdMs: number
): Promise<{ skipped: boolean; accepted: boolean; helloWaitMs: number }> {
  if (!stillOpen(pump, stream, signal)) {
    return { skipped: true, accepted: false, helloWaitMs: 0 };
  }
  const started = Date.now();
  const waited = new Promise<void>((resolve) => {
    pump.helloWait = resolve;
  });
  await Promise.race([waited, host.sleep(holdMs, signal).catch(() => undefined)]);
  pump.helloWait = null;
  return {
    skipped: false,
    accepted: stillOpen(pump, stream, signal),
    helloWaitMs: Date.now() - started,
  };
}

export function sameTransportPreAckCapped(
  outcome: string,
  refused: boolean | undefined,
  transport: string | null,
  seen: { transport: string | null; fails: number }
): boolean {
  if (outcome !== 'retry-no-hello' || !refused) return false;
  const key = transport ?? 'none';
  if (key === seen.transport) seen.fails += 1;
  else {
    seen.transport = key;
    seen.fails = 1;
  }
  return seen.fails > SAME_TRANSPORT_PRE_ACK_RETRIES;
}

function stillOpen(pump: HoldPump, stream: OpenedWsStream, signal: AbortSignal): boolean {
  if (!pump.streamAlive || pump.stream !== stream) return false;
  return !pump.browserClosed && !signal.aborted;
}
