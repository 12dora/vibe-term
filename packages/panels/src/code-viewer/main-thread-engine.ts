// worker 不可用时的兜底引擎。语言走整包表（一个 chunk，与 markdown 预览共用），
// 不用逐语言动态 import——兜底路径本来就少见，省一次分包比省字节重要。
import coreHljs from 'highlight.js/lib/core';
import { createHighlightEngine } from './highlight-engine';
import type { LanguageResolver } from './language-loaders';
import { AUTO_DETECT_LANGUAGES } from './language-map';

const loadLanguageFromBundle: LanguageResolver = async (name) => {
  const { BUNDLED_LANGUAGES } = await import('./bundled-languages');
  return BUNDLED_LANGUAGES[name] ?? null;
};

export const mainThreadHighlightEngine = createHighlightEngine({
  hljs: coreHljs,
  loadLanguage: loadLanguageFromBundle,
  autoDetectLanguages: AUTO_DETECT_LANGUAGES,
});
