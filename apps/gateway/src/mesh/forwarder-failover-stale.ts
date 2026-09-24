import { wsBorsh } from '@vibeterm/shared';
import { DEFAULT_DIAL_RTT_MS, adaptiveDeadlineMs, nestedDialBudgetsMs } from '@vibeterm/shared/net';

/** 输入 TTL 下限；实际值与客户端一致，按取链预算放大到最多 45 s。 */
export const STREAM_STALE_INPUT_TTL_MS = 10_000;

export function streamStaleInputTtlMs(budgetMs: number): number {
  return adaptiveDeadlineMs({
    rttMs: budgetMs,
    factor: 4,
    minMs: STREAM_STALE_INPUT_TTL_MS,
    maxMs: 45_000,
  });
}

export type StaleQueueDrop = { droppedFrames: number; droppedBytes: number; oldestAgeMs: number };

type StalePump = { queue: Uint8Array[]; queuedAt: number[]; queueBytes: number };

/**
 * failover 恢复后不再补发排队过久的终端输入：用户对着卡住的终端敲的 `exit` / Ctrl-D
 * 几十秒后落到已恢复的 pane 会杀掉里面的进程。只丢输入帧，结构帧（订阅、连接、resize）照旧。
 */
export function dropStaleQueuedInput(
  pump: StalePump,
  now: number,
  ttlMs: number = streamStaleInputTtlMs(nestedDialBudgetsMs(DEFAULT_DIAL_RTT_MS).forwardMs)
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
  if (droppedFrames > 0) replaceQueue(pump, keptFrames, keptAt, droppedBytes);
  return { droppedFrames, droppedBytes, oldestAgeMs };
}

function replaceQueue(
  pump: StalePump,
  frames: Uint8Array[],
  at: number[],
  droppedBytes: number
): void {
  pump.queue.length = 0;
  pump.queue.push(...frames);
  pump.queuedAt.length = 0;
  pump.queuedAt.push(...at);
  pump.queueBytes = Math.max(0, pump.queueBytes - droppedBytes);
}

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
