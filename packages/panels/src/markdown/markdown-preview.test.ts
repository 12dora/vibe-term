import { describe, expect, it } from 'bun:test';
import { resolveImgSrc } from './markdown-preview';

const resolver = (absPath: string) =>
  `/api/files/raw?rootId=r1&path=${encodeURIComponent(absPath)}`;

describe('resolveImgSrc', () => {
  it('外链与 data URI 原样返回', () => {
    expect(resolveImgSrc('https://cdn.example.com/a.png', '/docs', resolver)).toBe(
      'https://cdn.example.com/a.png'
    );
    expect(resolveImgSrc('//cdn.example.com/a.png', '/docs', resolver)).toBe(
      '//cdn.example.com/a.png'
    );
    expect(resolveImgSrc('data:image/png;base64,AA', '/docs', resolver)).toBe(
      'data:image/png;base64,AA'
    );
  });

  it('未注入 resolver 时不改写本地 src', () => {
    expect(resolveImgSrc('./img/a.png', '/docs', null)).toBe('./img/a.png');
    expect(resolveImgSrc('/abs/a.png', '/docs', null)).toBe('/abs/a.png');
  });

  it('相对路径基于 basePath 归一后交给 resolver', () => {
    expect(resolveImgSrc('./img/a.png', '/docs', (p) => p)).toBe('/docs/img/a.png');
    expect(resolveImgSrc('../assets/a.png', '/docs/guide', (p) => p)).toBe('/docs/assets/a.png');
    expect(resolveImgSrc('a.png', '/docs/', (p) => p)).toBe('/docs/a.png');
  });

  it('绝对路径归一后交给 resolver', () => {
    expect(resolveImgSrc('/docs//img/./a.png', '/docs', (p) => p)).toBe('/docs/img/a.png');
  });

  it('resolver 决定最终 URL（宿主注入 rootId）', () => {
    expect(resolveImgSrc('./a.png', '/docs', resolver)).toBe(
      '/api/files/raw?rootId=r1&path=%2Fdocs%2Fa.png'
    );
  });
});
