// 高亮 worker：把 highlight.js 整条链（内核 + 按需语言模块）挪出主线程。
// 排队与取消语义见 `highlight-queue.ts`。
import coreHljs from 'highlight.js/lib/core';
import { createHighlightEngine } from './highlight-engine';
import type { HighlightWorkerRequest, HighlightWorkerResponse } from './highlight-protocol';
import { createHighlightQueue } from './highlight-queue';
import { loadLanguageChunk } from './language-loaders';
import { AUTO_DETECT_LANGUAGES } from './language-map';

// tsconfig 的 lib 是 DOM（组件包共用），worker 全局在这里手写最小面。
interface HighlightWorkerScope {
  postMessage(message: HighlightWorkerResponse): void;
  addEventListener(
    type: 'message',
    handler: (event: MessageEvent<HighlightWorkerRequest>) => void
  ): void;
}

const engine = createHighlightEngine({
  hljs: coreHljs,
  loadLanguage: loadLanguageChunk,
  autoDetectLanguages: AUTO_DETECT_LANGUAGES,
});

const scope = self as unknown as HighlightWorkerScope;

const queue = createHighlightQueue({
  run: ({ code, fileName }) => engine.highlight(code, fileName).then((outcome) => outcome.html),
  emit: (response) => scope.postMessage(response),
});

scope.addEventListener('message', (event) => queue.handle(event.data));
