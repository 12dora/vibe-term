import { pullFileFromDevice, pushFileToDevice } from '../files/device-storage';
import {
  type UploadSession,
  createDownloadSession,
  removeUploadSession,
} from '../files/transfer-session';

export interface NdjsonProgressHelpers {
  emit: (obj: unknown) => void;
  close: () => void;
}

export interface NdjsonProgressStreamOptions {
  start: (helpers: NdjsonProgressHelpers) => void | Promise<void>;
  cancel?: () => void;
}

const NDJSON_PROGRESS_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store',
};

export function createNdjsonProgressStream(
  options: NdjsonProgressStreamOptions
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          // 控制器已关闭（客户端断开）
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      };
      return options.start({ emit, close });
    },
    cancel() {
      options.cancel?.();
    },
  });
}

export function ndjsonProgressResponse(options: NdjsonProgressStreamOptions): Response {
  return new Response(createNdjsonProgressStream(options), {
    status: 200,
    headers: NDJSON_PROGRESS_HEADERS,
  });
}

export function streamUploadCommit(session: UploadSession): Response {
  return ndjsonProgressResponse({
    start({ emit, close }) {
      pushFileToDevice(session.rootId, session.destDir, session.tmpPath, session.name, {
        signal: session.abort.signal,
        onProgress: (p) => emit({ type: 'progress', ...p }),
      })
        .then((res) => {
          if (res.ok) emit({ type: 'done', uploaded: res.data.uploaded });
          else emit({ type: 'error', code: res.code, detail: res.detail });
        })
        .catch((e) => emit({ type: 'error', code: 'unknown', detail: String(e) }))
        .finally(() => {
          close();
          removeUploadSession(session.id);
        });
    },
    cancel() {
      removeUploadSession(session.id);
    },
  });
}

export function streamDownloadPrepare(req: Request): Response {
  let abort: AbortController | null = null;
  return ndjsonProgressResponse({
    async start({ emit, close }) {
      let body: { rootId?: unknown; path?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        emit({ type: 'error', code: 'invalid' });
        close();
        return;
      }
      const rootId = typeof body.rootId === 'string' ? body.rootId : '';
      const path = typeof body.path === 'string' ? body.path : '';
      if (!rootId || !path) {
        emit({ type: 'error', code: 'invalid' });
        close();
        return;
      }
      abort = new AbortController();
      const result = await pullFileFromDevice(rootId, path, {
        signal: abort.signal,
        onProgress: (p) => emit({ type: 'progress', ...p }),
      });
      if (result.ok) {
        const s = createDownloadSession({
          tmpPath: result.data.tmpPath,
          size: result.data.size,
          name: result.data.name,
          mime: result.data.mime,
          cleanup: result.data.cleanup,
        });
        emit({ type: 'done', downloadId: s.id, size: s.size, name: s.name });
      } else {
        emit({ type: 'error', code: result.code, detail: result.detail });
      }
      close();
    },
    cancel() {
      abort?.abort();
    },
  });
}
