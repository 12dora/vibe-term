import { wsBorsh } from '@vibeterm/shared';
import type { ForwardPump } from './forwarder-failover';
import type { OpenedWsStream } from './mesh-deps';

export type SilentReplay = {
  helloWaitMs: number;
  resumeWaitMs: number;
  resumed: number;
  helloOk: boolean;
  helloReplied: boolean;
};

export type FirstInbound = SilentReplay | { upgradeHello: Uint8Array; helloWaitMs: number };

type WaitFn = (key: 'helloWait' | 'resumeWait', ms: number) => Promise<number>;

export function queuedHello(pump: ForwardPump): Uint8Array | null {
  if (pump.replay.hello) return pump.replay.hello;
  for (const frame of pump.queue) {
    if (isHelloC2S(frame)) return frame;
  }
  return null;
}

/** HELLO 路径会自己重发；留在队列里 flush 会再打一帧。 */
export function forgetQueuedHello(pump: ForwardPump): void {
  const idx = pump.queue.findIndex((frame) => isHelloC2S(frame));
  if (idx < 0) return;
  const [removed] = pump.queue.splice(idx, 1);
  pump.queuedAt.splice(idx, 1);
  if (removed) pump.queueBytes = Math.max(0, pump.queueBytes - removed.byteLength);
}

export async function waitForFirstInbound(
  pump: ForwardPump,
  stream: OpenedWsStream,
  signal: AbortSignal,
  budgetMs: number,
  wait: WaitFn
): Promise<FirstInbound> {
  if (pumpDead(pump, signal)) return silentReplay(0);
  if (!streamStillBound(pump, stream)) {
    return { helloWaitMs: 0, resumeWaitMs: 0, resumed: 0, helloOk: true, helloReplied: false };
  }
  if (pump.sawInbound) {
    return { helloWaitMs: 0, resumeWaitMs: 0, resumed: 0, helloOk: true, helloReplied: true };
  }
  const helloWaitMs = await wait('helloWait', budgetMs);
  const late = queuedHello(pump);
  if (late && streamStillBound(pump, stream) && !pumpDead(pump, signal)) {
    return { upgradeHello: late, helloWaitMs };
  }
  if (pump.sawInbound && streamStillBound(pump, stream) && !pumpDead(pump, signal)) {
    return { helloWaitMs, resumeWaitMs: 0, resumed: 0, helloOk: true, helloReplied: true };
  }
  return silentReplay(helloWaitMs);
}

function silentReplay(helloWaitMs: number): SilentReplay {
  return { helloWaitMs, resumeWaitMs: 0, resumed: 0, helloOk: false, helloReplied: false };
}

function streamStillBound(pump: ForwardPump, stream: OpenedWsStream): boolean {
  return pump.streamAlive && pump.stream === stream;
}

function pumpDead(pump: ForwardPump, signal: AbortSignal): boolean {
  return pump.browserClosed || signal.aborted;
}

function isHelloC2S(frame: Uint8Array): boolean {
  try {
    return wsBorsh.decodeEnvelopeView(frame).kind === wsBorsh.KIND_HELLO_C2S;
  } catch {
    return false;
  }
}
