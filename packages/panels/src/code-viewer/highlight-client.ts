// 高亮请求的主线程侧：优先丢给 worker；worker 不可用（或运行时报错）时退回主线程，
// 但先让出一帧，保证纯文本已经上屏——hljs 的输出本身按行嵌套 span，切不开，只能整段跑。
// 每个请求可取消：除了丢弃回包，取消还必须发给 worker，否则连切几个大文件时
// 已作废的请求仍会在 worker 里逐个跑完，把最新文件排在后面。

import type { HighlightWorkerLike, HighlightWorkerResponse } from './highlight-protocol';

export type HighlightResultHandler = (html: string | null) => void;

export interface HighlightClient {
  request(code: string, fileName: string, onResult: HighlightResultHandler): () => void;
  dispose(): void;
}

export interface HighlightClientOptions {
  spawnWorker?: () => HighlightWorkerLike | null;
  highlightOnMainThread?: (code: string, fileName: string) => Promise<string | null>;
}

/** 让出主线程一帧，保证纯文本先上屏。scheduler.yield 可用时优先用它（保留任务优先级）。 */
function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function defaultSpawnWorker(): HighlightWorkerLike | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return null;
  }
  try {
    const worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), {
      type: 'module',
    });
    return worker as unknown as HighlightWorkerLike;
  } catch {
    return null;
  }
}

async function defaultHighlightOnMainThread(
  code: string,
  fileName: string
): Promise<string | null> {
  await yieldToMain();
  const { mainThreadHighlightEngine } = await import('./main-thread-engine');
  const { html } = await mainThreadHighlightEngine.highlight(code, fileName);
  return html;
}

export function createHighlightClient(options: HighlightClientOptions = {}): HighlightClient {
  const spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
  const highlightOnMainThread = options.highlightOnMainThread ?? defaultHighlightOnMainThread;

  const pending = new Map<
    number,
    { code: string; fileName: string; onResult: HighlightResultHandler }
  >();
  let worker: HighlightWorkerLike | null | undefined;
  let nextId = 1;
  let disposed = false;

  function deliver(id: number, html: string | null): void {
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);
    entry.onResult(html);
  }

  function runOnMainThread(id: number): void {
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    void highlightOnMainThread(entry.code, entry.fileName).then(
      (html) => deliver(id, html),
      () => deliver(id, null)
    );
  }

  function dropWorker(): void {
    if (!worker) {
      return;
    }
    worker.terminate();
    worker = null;
    for (const id of [...pending.keys()]) {
      runOnMainThread(id);
    }
  }

  function ensureWorker(): HighlightWorkerLike | null {
    if (worker !== undefined) {
      return worker;
    }
    worker = spawnWorker();
    if (worker) {
      worker.addEventListener('message', (event: MessageEvent<HighlightWorkerResponse>) => {
        deliver(event.data.id, event.data.html);
      });
      worker.addEventListener('error', dropWorker);
      worker.addEventListener('messageerror', dropWorker);
    }
    return worker;
  }

  return {
    request(code, fileName, onResult) {
      if (disposed) {
        return () => {};
      }
      const id = nextId++;
      pending.set(id, { code, fileName, onResult });
      const active = ensureWorker();
      if (active) {
        active.postMessage({ type: 'highlight', id, code, fileName });
      } else {
        runOnMainThread(id);
      }
      return () => {
        if (!pending.delete(id)) return;
        worker?.postMessage({ type: 'cancel', id });
      };
    },
    dispose() {
      disposed = true;
      pending.clear();
      if (worker) {
        worker.terminate();
      }
      worker = null;
    },
  };
}

let shared: HighlightClient | undefined;

export function sharedHighlightClient(): HighlightClient {
  if (!shared) {
    shared = createHighlightClient();
  }
  return shared;
}
