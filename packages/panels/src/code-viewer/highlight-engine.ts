// 高亮内核：按需注册语言 + 出高亮 HTML。只被 worker 与主线程兜底路径加载，不进首屏图。

import type { HLJSApi } from 'highlight.js';
import type { LanguageResolver } from './language-loaders';
import { planHighlight } from './language-map';

/** html 为 null 表示未高亮，调用方直接把原文当文本渲染（由框架转义，无需自己拼 HTML）。 */
export interface HighlightOutcome {
  html: string | null;
}

export interface HighlightEngine {
  highlight(code: string, fileName: string): Promise<HighlightOutcome>;
}

export interface HighlightEngineOptions {
  hljs: HLJSApi;
  loadLanguage: LanguageResolver;
  autoDetectLanguages: readonly string[];
}

const PLAIN: HighlightOutcome = { html: null };

export function createHighlightEngine({
  hljs,
  loadLanguage,
  autoDetectLanguages,
}: HighlightEngineOptions): HighlightEngine {
  // 已发起的加载按语言名缓存：同一语言只 import + registerLanguage 一次，失败则允许重试。
  const loading = new Map<string, Promise<boolean>>();

  function ensureLanguage(name: string): Promise<boolean> {
    if (hljs.getLanguage(name)) {
      return Promise.resolve(true);
    }
    const inflight = loading.get(name);
    if (inflight) {
      return inflight;
    }
    const task = loadLanguage(name)
      .then((language) => {
        if (!language) {
          loading.delete(name);
          return false;
        }
        if (!hljs.getLanguage(name)) {
          hljs.registerLanguage(name, language);
        }
        return true;
      })
      .catch(() => {
        loading.delete(name);
        return false;
      });
    loading.set(name, task);
    return task;
  }

  async function ensureAutoDetectSubset(): Promise<string[]> {
    const loaded = await Promise.all(autoDetectLanguages.map((name) => ensureLanguage(name)));
    return autoDetectLanguages.filter((_, index) => loaded[index]);
  }

  async function highlight(code: string, fileName: string): Promise<HighlightOutcome> {
    const plan = planHighlight(code.length, fileName);
    if (plan.mode === 'plain') {
      return PLAIN;
    }
    try {
      if (plan.mode === 'language') {
        return (await ensureLanguage(plan.language))
          ? { html: hljs.highlight(code, { language: plan.language }).value }
          : PLAIN;
      }
      const subset = await ensureAutoDetectSubset();
      return subset.length > 0 ? { html: hljs.highlightAuto(code, subset).value } : PLAIN;
    } catch {
      return PLAIN;
    }
  }

  return { highlight };
}
