// 按需加载 highlight.js 语言模块。键与顺序同 COMMON_LANGUAGE_NAMES（即上游 lib/common.js）。
//
// 刻意不用 `highlight.js/lib/common`：那个入口是 CJS 构建（`lib/languages/*.js`），而 markdown
// 预览那条链（rehype-highlight → lowlight）拿的是同一批语法的 ESM 构建（`es/languages/*.js`）。
// 包的 exports map 把 `import` 条件指向 ESM 构建，动态 import 同样命中它，两条链共用同一批模块。
import type { LanguageFn } from 'highlight.js';

export type LanguageLoader = () => Promise<{ default: LanguageFn }>;

/** 取一个语言语法；拿不到（无此语言 / 加载失败）返回 null。 */
export type LanguageResolver = (name: string) => Promise<LanguageFn | null>;

export const LANGUAGE_LOADERS: Readonly<Record<string, LanguageLoader>> = {
  xml: () => import('highlight.js/lib/languages/xml'),
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  diff: () => import('highlight.js/lib/languages/diff'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  go: () => import('highlight.js/lib/languages/go'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  less: () => import('highlight.js/lib/languages/less'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  perl: () => import('highlight.js/lib/languages/perl'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  php: () => import('highlight.js/lib/languages/php'),
  'php-template': () => import('highlight.js/lib/languages/php-template'),
  plaintext: () => import('highlight.js/lib/languages/plaintext'),
  python: () => import('highlight.js/lib/languages/python'),
  'python-repl': () => import('highlight.js/lib/languages/python-repl'),
  r: () => import('highlight.js/lib/languages/r'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scss: () => import('highlight.js/lib/languages/scss'),
  shell: () => import('highlight.js/lib/languages/shell'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  vbnet: () => import('highlight.js/lib/languages/vbnet'),
  wasm: () => import('highlight.js/lib/languages/wasm'),
};

/** worker 侧：一个文件只下它自己那一个语言 chunk。 */
export const loadLanguageChunk: LanguageResolver = async (name) => {
  const loader = LANGUAGE_LOADERS[name];
  return loader ? (await loader()).default : null;
};
