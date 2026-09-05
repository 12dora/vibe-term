import type { LinkStream, StreamChunk } from '@tmex/shared/link';

type HubRelayRstReason = 'relay-rst:src-read' | 'relay-rst:dst-write' | 'relay-rst:peer-abort';

export function pumpHubRelay(a: LinkStream, b: LinkStream): void {
  let finished = false;
  const abortBoth = (reason: HubRelayRstReason): void => {
    if (finished) return;
    finished = true;
    try {
      a.reset(reason);
    } catch {
      // already closed
    }
    try {
      b.reset(reason);
    } catch {
      // already closed
    }
  };
  a.onAbort(() => abortBoth('relay-rst:peer-abort'));
  b.onAbort(() => abortBoth('relay-rst:peer-abort'));
  void Promise.all([
    pumpHubRelayDirection(a, b, abortBoth),
    pumpHubRelayDirection(b, a, abortBoth),
  ]).then(
    () => {
      finished = true;
    },
    () => abortBoth('relay-rst:src-read')
  );
}

async function pumpHubRelayDirection(
  src: LinkStream,
  dst: LinkStream,
  onError: (reason: HubRelayRstReason) => void
): Promise<void> {
  const reader = src.readable.getReader();
  try {
    for (;;) {
      let chunk: { done: boolean; value?: StreamChunk };
      try {
        chunk = await reader.read();
      } catch {
        await halfCloseHubRelay(dst, onError, 'relay-rst:src-read');
        return;
      }
      if (chunk.done) break;
      const value = chunk.value;
      if (!value || (value.bytes.byteLength === 0 && !value.head)) continue;
      try {
        await dst.write(value.bytes, value.head ? { head: true } : undefined);
      } catch {
        await halfCloseHubRelay(dst, onError, 'relay-rst:dst-write');
        return;
      }
    }
    try {
      await dst.end();
    } catch {
      onError('relay-rst:dst-write');
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

async function halfCloseHubRelay(
  dst: LinkStream,
  onError: (reason: HubRelayRstReason) => void,
  reason: HubRelayRstReason
): Promise<void> {
  try {
    await dst.end();
  } catch {
    onError(reason);
  }
}
