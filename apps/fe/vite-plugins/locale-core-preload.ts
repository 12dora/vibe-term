import type { Plugin } from 'vite';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 匹配 `assets/<locale>.core-<hash>.js`，排除 mermaid.core 这类同名后缀。 */
export function localeCoreAssetPattern(locale: string): RegExp {
  return new RegExp(`(?:^|/)${escapeRegex(locale)}\\.core-[A-Za-z0-9_-]+\\.js$`);
}

export function findLocaleCoreAsset(names: readonly string[], locale: string): string | null {
  const pattern = localeCoreAssetPattern(locale);
  const matches = names
    .map((name) => name.replace(/\\/g, '/'))
    .filter((name) => pattern.test(name))
    .sort();
  if (matches.length === 0) return null;
  return matches.find((name) => name.startsWith('assets/')) ?? matches[0] ?? null;
}

export function injectLocaleCorePreload(html: string, asset: string): string {
  const href = asset.startsWith('/') ? asset : `/${asset}`;
  if (html.includes(`href="${href}"`)) return html;
  const tag = `<link rel="modulepreload" crossorigin href="${href}">`;
  if (!/<\/head>/i.test(html)) {
    throw new Error(
      '[vibeterm-locale-core-preload] index.html 缺少 </head>，无法写入 modulepreload'
    );
  }
  return html.replace(
    /([ \t]*)<\/head>/i,
    (_match, indent: string) => `${indent}  ${tag}\n${indent}</head>`
  );
}

export function localeCorePreloadPlugin(locale: string): Plugin {
  return {
    name: 'vibeterm-locale-core-preload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const names = ctx.bundle ? Object.keys(ctx.bundle) : [];
        const asset = findLocaleCoreAsset(names, locale);
        if (!asset) {
          throw new Error(
            `[vibeterm-locale-core-preload] 没有找到 ${locale}.core-*.js，无法写入 modulepreload`
          );
        }
        return injectLocaleCorePreload(html, asset);
      },
    },
  };
}
