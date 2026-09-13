// 窄屏判定：只认真正的视口读数。单测里的 matchMedia 桩一律回同一个 `matches` 且不带 `media`，
// 照它的读数会把别处的宽表也换成卡片，因此这种桩必须被当成「不知道」→ 宽屏。

import { afterEach, describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { useNarrowLayout } = await import('./use-narrow-layout');

function Probe() {
  return <span>{useNarrowLayout() ? 'narrow' : 'wide'}</span>;
}

function setMatchMedia(value: unknown): void {
  (globalThis.window as unknown as { matchMedia?: unknown }).matchMedia = value;
}

afterEach(() => {
  (globalThis.window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
});

describe('useNarrowLayout', () => {
  test('没有 matchMedia 时按宽屏处理', () => {
    setMatchMedia(undefined);
    expect(renderToStaticMarkup(<Probe />)).toContain('wide');
  });

  test('不带 media 的桩不算数：仍按宽屏处理', () => {
    setMatchMedia(() => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    expect(renderToStaticMarkup(<Probe />)).toContain('wide');
  });

  test('真实读数：命中窄屏查询时换记录卡', () => {
    setMatchMedia((media: string) => ({
      media,
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    expect(renderToStaticMarkup(<Probe />)).toContain('narrow');
  });

  test('真实读数：宽屏时留在表格', () => {
    setMatchMedia((media: string) => ({
      media,
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    expect(renderToStaticMarkup(<Probe />)).toContain('wide');
  });
});
