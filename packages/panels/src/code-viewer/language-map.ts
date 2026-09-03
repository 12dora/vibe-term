// 扩展名 -> highlight.js 语言名映射与高亮策略判定。
// 本模块刻意不 import highlight.js：它随 CodeViewer 进主 chunk，只放纯表和纯函数。

// 顺序与 `highlight.js/lib/common.js` 逐行一致（highlightAuto 的相关度排序会看注册顺序），
// 勿随手排序；`code-viewer.test.tsx` 会对着上游的 common.js 逐条比对。
export const COMMON_LANGUAGE_NAMES = [
  'xml',
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'markdown',
  'diff',
  'ruby',
  'go',
  'graphql',
  'ini',
  'java',
  'javascript',
  'json',
  'kotlin',
  'less',
  'lua',
  'makefile',
  'perl',
  'objectivec',
  'php',
  'php-template',
  'plaintext',
  'python',
  'python-repl',
  'r',
  'rust',
  'scss',
  'shell',
  'sql',
  'swift',
  'yaml',
  'typescript',
  'vbnet',
  'wasm',
] as const;

const COMMON_LANGUAGE_SET: ReadonlySet<string> = new Set(COMMON_LANGUAGE_NAMES);

// highlightAuto 的候选集：语言按需注册后，「当前已注册了什么」取决于用户此前看过哪些文件，
// 不钉死子集就会让同一个文件在不同会话里识别出不同语言。子集同时是自动识别的成本上限
// （highlightAuto 要拿每个候选语法各跑一遍），11 个候选覆盖无扩展名/未知扩展名的常见形态：
// 脚本、配置、笔记、补丁，以及三大通用语法。
export const AUTO_DETECT_LANGUAGES: readonly string[] = [
  'bash',
  'c',
  'diff',
  'go',
  'ini',
  'javascript',
  'json',
  'markdown',
  'python',
  'xml',
  'yaml',
];

// 文件扩展名 -> highlight.js 语言名映射，覆盖常见语言。
// 映射到 COMMON_LANGUAGE_NAMES 之外的名字（dockerfile / dart / scala / powershell / toml）
// 没有对应的按需加载器，会退回自动识别——与按需注册之前的行为一致。
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  cts: 'typescript',
  mts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  scala: 'scala',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  jsonc: 'json',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  dart: 'dart',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
};

export function resolveLanguage(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  // 无扩展名的特例文件（Dockerfile / Makefile）
  if (lower === 'dockerfile' || lower.endsWith('.dockerfile')) {
    return 'dockerfile';
  }
  if (lower === 'makefile') {
    return 'makefile';
  }
  const dot = lower.lastIndexOf('.');
  if (dot < 0) {
    return undefined;
  }
  return EXT_TO_LANG[lower.slice(dot + 1)];
}

// highlightAuto 要拿全部候选语法各跑一遍，代价随体积暴涨（1 MiB 未知文本 ~7.7 s），
// 所以只对小文件做自动识别；已知语言的 hljs.highlight 快两个数量级，阈值放宽即可。
// 网关放行的文本上限是 2 MiB，两条线以上一律渲染纯文本。
export const AUTO_DETECT_LIMIT = 64 * 1024;
export const HIGHLIGHT_LIMIT = 512 * 1024;

export type HighlightPlan =
  | { mode: 'language'; language: string }
  | { mode: 'auto' }
  | { mode: 'plain' };

/** 主线程与 worker 共用的策略判定：决定是按语言高亮、自动识别，还是直接渲染纯文本。 */
export function planHighlight(codeLength: number, fileName: string): HighlightPlan {
  const language = resolveLanguage(fileName);
  if (language && COMMON_LANGUAGE_SET.has(language)) {
    return codeLength > HIGHLIGHT_LIMIT ? { mode: 'plain' } : { mode: 'language', language };
  }
  return codeLength > AUTO_DETECT_LIMIT ? { mode: 'plain' } : { mode: 'auto' };
}
