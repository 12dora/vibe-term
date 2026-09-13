import { errorMessage } from '@vibeterm/shared';

const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store',
};

export function execNdjsonResponse(
  run: (emit: (obj: unknown) => void, isOpen: () => boolean) => Promise<void>,
  onCancel: () => void
): Response {
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (obj: unknown) => enqueueLine(controller, encoder, obj, () => open);
      void run(emit, () => open)
        .catch((err) => {
          emit({ type: 'error', code: 'exec_spawn_failed', message: errorMessage(err) });
        })
        .finally(() => {
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
