// 卸载复原的浏览器标题：站点名与设置路径一样要做 U+FE0E 字形归一。

import { describe, expect, test } from 'bun:test';
import { restoredBrowserTitle } from './use-device-console-effects';

const VS15 = '\uFE0E';

describe('restoredBrowserTitle', () => {
  test('站点名里的图形字符补上 U+FE0E', () => {
    expect(restoredBrowserTitle('✳ tmex')).toBe(`✳${VS15} tmex`);
  });

  test('普通站点名原样返回', () => {
    expect(restoredBrowserTitle('tmex')).toBe('tmex');
  });

  test('宿主自带格式化器时交给它，不再插手', () => {
    expect(restoredBrowserTitle('✳ tmex', (label) => `${label ?? 'none'}!`)).toBe('none!');
  });
});
