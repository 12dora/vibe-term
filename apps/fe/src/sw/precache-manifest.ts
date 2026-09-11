// SW 预缓存清单的组装：纯字符串处理，构建期由 vite.config.ts 的 serviceWorkerPlugin 调用。
// 放在 src/sw 下是为了能用 bun:test 直接覆盖——清单算错的后果（首屏资源漏缓存、
// 或者把懒 chunk 混进 addAll 导致整代安装失败）在构建日志里看不出来。

export interface SwPrecacheManifest {
  /** 首屏必备，进 cache.addAll（缺一不可） */
  core: string[];
  /** 其余哈希 chunk + 有子集垫底的完整字体，尽力而为；弱网 / 省流量下整档跳过 */
  lazy: string[];
  /** 首屏就要的字体：latin 子集与没有子集的小字体，尽力而为但从不跳过 */
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

/** 可选字体家族的存放前缀：那是 16 MB 的按需资源，只在用户选中时运行时缓存，绝不预缓存 */
export const OPTIONAL_FONT_PREFIX = '/fonts/generated/';

/**
 * 从产物 CSS 的静态 @font-face 里取默认字体 URL。显式剔掉 /fonts/generated/**：
 * 它们目前只由运行时注入的 @font-face 引用，但一旦哪天进了 CSS，这里会悄悄把 16 MB
 * 塞进每一代预缓存。
 */
export function declaredFontUrls(css: string): string[] {
  const found = css.match(/\/fonts\/[^"')]+\.woff2/g) ?? [];
  return [...new Set(found.filter((url) => !url.startsWith(OPTIONAL_FONT_PREFIX)))].sort();
}

/** 子集面的文件名后缀，由 `bun run build:fonts` 生成（如 `-Regular-latin.woff2`） */
export const FONT_SUBSET_SUFFIX = '-latin';

function subsetUrlOf(url: string): string {
  return url.replace(/\.woff2$/, `${FONT_SUBSET_SUFFIX}.woff2`);
}

/**
 * 字体分档。带 `unicode-range` 的完整面（Geist Mono Nerd 每个 1.16 MB，只覆盖 PUA 与其余区）
 * 有 latin 子集垫底，首屏根本用不上它——放进 lazy 档，弱网时整档跳过，第一次出现 PUA 图标
 * 时 CSS 自己会去取，运行时 cache-first 照样把它收进本代缓存。
 * 判据是「同名的 `-latin` 子集也被声明了」：将来多切几个子集也不用改这里。
 */
export function splitFontTiers(urls: readonly string[]): { eager: string[]; deferred: string[] } {
  const declared = new Set(urls);
  const deferred = new Set(
    urls.filter(
      (url) => !url.endsWith(`${FONT_SUBSET_SUFFIX}.woff2`) && declared.has(subsetUrlOf(url))
    )
  );
  return { eager: urls.filter((url) => !deferred.has(url)), deferred: [...deferred] };
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
  const { eager, deferred } = splitFontTiers(declaredFontUrls(input.css));
  return {
    core: [SHELL_PRECACHE_URL, ...entry],
    lazy: [...emitted.filter((url) => !entry.has(url)), ...deferred],
    fonts: eager,
  };
}
