// SW 预缓存清单的组装：纯字符串处理，构建期由 vite.config.ts 的 serviceWorkerPlugin 调用。
// 放在 src/sw 下是为了能用 bun:test 直接覆盖——清单算错的后果（首屏资源漏缓存、
// 或者把懒 chunk 混进 addAll 导致整代安装失败）在构建日志里看不出来。

export interface SwPrecacheManifest {
  /** 首屏必备，进 cache.addAll（缺一不可） */
  core: string[];
  /** 其余哈希 chunk，尽力而为 */
  lazy: string[];
  /** 默认等宽字体，尽力而为 */
  fonts: string[];
}

/** 应用壳在缓存里的键 */
export const SHELL_PRECACHE_URL = '/index.html';

/** 参与预缓存的产物：只收 assets/ 下带哈希的 js / css / wasm */
export const PRECACHE_ASSET_PATTERN = /^assets\/.+\.(?:js|css|wasm)$/;

const EMITTED_CSS_PATTERN = /^assets\/.+\.css$/;

/** 打包产物里的样式表名。字体 URL 要从**产物** CSS 里找：src/index.css 还有一串 @import。 */
export function emittedCssNames(bundleNames: readonly string[]): string[] {
  return bundleNames.filter((name) => EMITTED_CSS_PATTERN.test(name)).sort();
}

/**
 * index.html 直接引用的首屏资源：入口 module 脚本 + 它的 modulepreload 集合 + 样式表。
 * 与 scripts/check-bundle-budget.ts 的首屏口径一致。
 */
export function htmlReferencedAssets(html: string): string[] {
  const refs = new Set<string>();
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    if (!/type="module"|rel="(?:modulepreload|stylesheet)"/.test(tag)) continue;
    const file = tag.match(/(?:src|href)="\/?(assets\/[A-Za-z0-9._-]+\.(?:js|css))"/)?.[1];
    if (file) refs.add(`/${file}`);
  }
  return [...refs].sort();
}

/** 从产物 CSS 的静态 @font-face 里取默认字体 URL（不含 /fonts/generated/** 的可选家族） */
export function declaredFontUrls(css: string): string[] {
  return [...new Set(css.match(/\/fonts\/[^"')]+\.woff2/g) ?? [])].sort();
}

/** 打包产物名（相对 outDir）→ 预缓存 URL；非 assets/ 哈希产物一律忽略 */
export function precacheAssetUrls(bundleNames: readonly string[]): string[] {
  return bundleNames
    .filter((name) => PRECACHE_ASSET_PATTERN.test(name))
    .map((name) => `/${name}`)
    .sort();
}

export function buildPrecacheManifest(input: {
  html: string;
  bundleNames: readonly string[];
  css: string;
}): SwPrecacheManifest {
  const emitted = precacheAssetUrls(input.bundleNames);
  const entry = new Set(htmlReferencedAssets(input.html));
  return {
    core: [SHELL_PRECACHE_URL, ...entry],
    lazy: emitted.filter((url) => !entry.has(url)),
    fonts: declaredFontUrls(input.css),
  };
}
