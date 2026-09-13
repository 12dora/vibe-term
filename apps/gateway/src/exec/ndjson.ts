import { errorMessage } from '@vibeterm/shared';
import { EXEC_KEEPALIVE_MS } from './constants';

const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store',
};

export function execNdjsonResponse(
  run: (emit: (obj: unknown) => void, isOpen: () => boolean) => Promise<void>,
  onCancel: () => void,
  keepaliveMs = EXEC_KEEPALIVE_MS
): Response {
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (obj: unknown) => enqueueLine(controller, encoder, obj, () => open);
      const ping = armKeepalive(emit, () => open, keepaliveMs);
      void run(emit, () => open)
        .catch((err) => {
          emit({ type: 'error', code: 'exec_spawn_failed', message: errorMessage(err) });
        })
        .finally(() => {
          ping.stop();
          open = false;
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
    },
    cancel() {
      open = false;
      onCancel();
    },
  });
  return new Response(stream, { status: 200, headers: NDJSON_HEADERS });
}

function armKeepalive(
  emit: (obj: unknown) => void,
  isOpen: () => boolean,
  keepaliveMs: number
): { stop: () => void } {
  if (keepaliveMs <= 0) return { stop() {} };
  const timer = setInterval(() => {
    if (!isOpen()) return;
    emit({ type: 'ping', t: Date.now() });
  }, keepaliveMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function enqueueLine(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  obj: unknown,
  isOpen: () => boolean
): void {
  if (!isOpen()) return;
  try {
    controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
  } catch {
    // 控制器已关闭（客户端断开）
  }
}
