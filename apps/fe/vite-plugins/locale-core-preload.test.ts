import { describe, expect, test } from 'bun:test';
import {
  findLocaleCoreAsset,
  injectLocaleCorePreload,
  localeCoreAssetPattern,
} from './locale-core-preload';

describe('findLocaleCoreAsset', () => {
  const names = [
    'assets/index-DBk6mNEt.js',
    'assets/vendor-react-7NC-AHOP.js',
    'assets/en_US.core-D-TIM3UM.js',
    'assets/zh_CN.core-D16BCVEh.js',
    'assets/mermaid.core-Cvjv8mYM.js',
    'assets/core-D5yjdHof.js',
  ];

  test('只命中默认语言的 core chunk，不误伤 mermaid.core', () => {
    expect(findLocaleCoreAsset(names, 'en_US')).toBe('assets/en_US.core-D-TIM3UM.js');
    expect(findLocaleCoreAsset(names, 'zh_CN')).toBe('assets/zh_CN.core-D16BCVEh.js');
    expect(findLocaleCoreAsset(names, 'ja_JP')).toBeNull();
    expect(localeCoreAssetPattern('en_US').test('assets/mermaid.core-Cvjv8mYM.js')).toBe(false);
    expect(localeCoreAssetPattern('en_US').test('assets/core-D5yjdHof.js')).toBe(false);
  });
});

describe('injectLocaleCorePreload', () => {
  test('在 </head> 前插入 modulepreload，已存在则不重复', () => {
    const html = `<!doctype html><html><head>
    <script type="module" crossorigin src="/assets/index-DBk6mNEt.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-react-7NC-AHOP.js">
  </head><body></body></html>`;
    const once = injectLocaleCorePreload(html, 'assets/en_US.core-D-TIM3UM.js');
    expect(once).toContain(
      '<link rel="modulepreload" crossorigin href="/assets/en_US.core-D-TIM3UM.js">'
    );
    expect(injectLocaleCorePreload(once, 'assets/en_US.core-D-TIM3UM.js')).toBe(once);
  });
});
