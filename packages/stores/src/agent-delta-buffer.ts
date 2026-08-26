// 流式 delta 节流缓冲：每帧 set 会卡渲染，按固定间隔合并 flush 一次。

import type { AgentDataSetState } from './agent-state';
import { type SessionInProgress, emptyInProgress } from './agent-thread';

export const DELTA_FLUSH_MS = 40;

export type DeltaChannel = 'texts' | 'reasonings';

interface DeltaBufferEntry {
  texts: Map<string, string>;
  reasonings: Map<string, string>;
}

export interface AgentDeltaBuffer {
  append(sessionId: string, channel: DeltaChannel, messageId: string, delta: string): void;
  schedule(): void;
  flush(): void;
  clearSession(sessionId: string): void;
}

export function createAgentDeltaBuffer(
  setState: AgentDataSetState,
  flushMs: number = DELTA_FLUSH_MS
): AgentDeltaBuffer {
  const buffer = new Map<string, DeltaBufferEntry>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (buffer.size === 0) {
      return;
    }
    const buffered = new Map(buffer);
    buffer.clear();

    setState((prev) => {
      const nextInProgress = { ...prev.inProgress };
      for (const [sessionId, entry] of buffered) {
        const current = nextInProgress[sessionId] ?? emptyInProgress();
        const next: SessionInProgress = {
          ...current,
          texts: [...current.texts],
          reasonings: [...current.reasonings],
        };
        for (const channel of ['texts', 'reasonings'] as const) {
          for (const [messageId, delta] of entry[channel]) {
            const segments = next[channel];
            const index = segments.findIndex((segment) => segment.messageId === messageId);
            if (index >= 0) {
              segments[index] = {
                ...segments[index],
                text: segments[index].text + delta,
              };
            } else {
              // staleBarrier 不传染给新 messageId：barrier 窗口内已落库消息的残留 delta
              // 会命中上面的既有 stale 段分支；走到这里的是下一 step 新消息，正常入流，
              // 避免被 loadHistory 误清导致已显示文本闪缩
              segments.push({ messageId, text: delta, stale: false });
            }
          }
        }
        nextInProgress[sessionId] = next;
      }
      return { inProgress: nextInProgress };
    });
  }

  return {
    append(sessionId, channel, messageId, delta) {
      let entry = buffer.get(sessionId);
      if (!entry) {
        entry = { texts: new Map(), reasonings: new Map() };
        buffer.set(sessionId, entry);
      }
      const segments = entry[channel];
      segments.set(messageId, (segments.get(messageId) ?? '') + delta);
    },
    schedule() {
      if (flushTimer) return;
      flushTimer = setTimeout(flush, flushMs);
    },
    flush,
    clearSession(sessionId) {
      buffer.delete(sessionId);
    },
  };
}
