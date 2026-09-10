// SW 请求分类：穷举各类真实路径，重点验「绝不拦截」那一档——
// 一旦 API / WS / 子节点代理被误判成可缓存，线上会拿到过期响应甚至连不上。

import { describe, expect, test } from 'bun:test';
import {
  BYPASS_PREFIXES,
  NODE_BYPASS_SEGMENTS,
  PRECACHED_ICONS,
  SHELL_URL,
  type SwRequestInfo,
  type SwRouteKind,
  classifyRequest,
  isBypassPath,
  isNodeBypassPath,
} from './sw-routes';

const ORIGIN = 'https://vibeterm.example';

function info(path: string, overrides: Partial<SwRequestInfo> = {}): SwRequestInfo {
  return {
    url: path.startsWith('http') ? path : `${ORIGIN}${path}`,
    method: 'GET',
    mode: 'no-cors',
    hasRange: false,
    scopeOrigin: ORIGIN,
    ...overrides,
  };
}

function classify(path: string, overrides: Partial<SwRequestInfo> = {}): SwRouteKind {
  return classifyRequest(info(path, overrides));
}

describe('classifyRequest 不拦截的请求', () => {
  test('非 GET 一律直通', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(classify('/assets/index-abc12345.js', { method })).toBe('bypass');
      expect(classify('/', { method, mode: 'navigate' })).toBe('bypass');
    }
  });

  test('Range 请求直通', () => {
    expect(classify('/assets/index-abc12345.js', { hasRange: true })).toBe('bypass');
    expect(classify('/fonts/GeistMonoNerdFontMono-Regular.woff2', { hasRange: true })).toBe(
      'bypass'
    );
  });

  test('跨源请求直通', () => {
    expect(classify('https://cdn.example/assets/x-abc12345.js')).toBe('bypass');
    expect(classify('http://vibeterm.example/assets/x-abc12345.js')).toBe('bypass');
    expect(classify('/assets/x.js', { scopeOrigin: 'https://other.example' })).toBe('bypass');
  });

  test('非法 URL 直通', () => {
    expect(classifyRequest({ ...info('/'), url: 'not a url' })).toBe('bypass');
  });

  test('API / WS / mesh / healthz / sw.js 直通', () => {
    const paths = [
      '/api/devices',
      '/api/manifest.webmanifest',
      '/api/auth/mode',
      '/ws',
      '/ws?token=x',
      '/mesh/ws',
      '/mesh/nodes',
      '/healthz',
      '/sw.js',
    ];
    for (const path of paths) {
      expect(classify(path)).toBe('bypass');
      expect(classify(path, { mode: 'navigate' })).toBe('bypass');
    }
  });

  test('/n/<id>/ 下只有 ws / api / mesh 直通', () => {
    for (const path of [
      '/n/abc123/ws',
      '/n/abc123/ws/pane',
      '/n/abc123/api',
      '/n/abc123/api/devices',
      '/n/abc123/mesh/ws',
    ]) {
      expect(classify(path)).toBe('bypass');
      expect(classify(path, { mode: 'navigate' })).toBe('bypass');
    }
  });

  test('/n/<id>/assets 之类非导航请求仍直通（那是别的 node 的构建产物）', () => {
    expect(classify('/n/abc123/assets/index-abc12345.js')).toBe('bypass');
    expect(classify('/n/abc123/fonts/GeistMonoNerdFontMono-Bold.woff2')).toBe('bypass');
  });

  test('前缀相近但不同段的路径不被误判成传输层', () => {
    expect(classify('/n/abc123/website', { mode: 'navigate' })).toBe('shell');
    expect(classify('/n/abc123/apidocs', { mode: 'navigate' })).toBe('shell');
    expect(classify('/n/abc123/meshing', { mode: 'navigate' })).toBe('shell');
  });

  test('未知同源 GET 且非导航时直通（不做兜底缓存）', () => {
    expect(classify('/robots.txt')).toBe('bypass');
    expect(classify('/stats.html')).toBe('bypass');
  });
});

describe('classifyRequest 缓存分类', () => {
  test('哈希资源归 asset', () => {
    expect(classify('/assets/index-abc12345.js')).toBe('asset');
    expect(classify('/assets/vendor-react-a_b2-3d4E.js')).toBe('asset');
    expect(classify('/assets/index-abc12345.css')).toBe('asset');
    expect(classify('/assets/ghostty-vt-abc12345.wasm')).toBe('asset');
  });

  test('字体归 font（含按需的 generated 家族）', () => {
    expect(classify('/fonts/GeistMonoNerdFontMono-Regular.woff2')).toBe('font');
    expect(classify('/fonts/generated/fira-code/fira-code-regular.woff2')).toBe('font');
  });

  test('应用图标归 icon', () => {
    for (const icon of PRECACHED_ICONS) {
      expect(classify(icon)).toBe('icon');
    }
  });

  test('同源导航归 shell（含分享路由、深层应用路由与 node 作用域路由）', () => {
    const navigations = [
      '/',
      '/login',
      '/devices',
      '/device/mac/0/%251',
      '/s/abcdef123456',
      '/settings/nodes',
      '/n/abc123',
      '/n/abc123/devices',
      '/n/abc123/device/mac/0/%251',
      '/n/abc123/s/AbCd1234',
    ];
    for (const path of navigations) {
      expect(classify(path, { mode: 'navigate' })).toBe('shell');
    }
  });

  test('资源分类优先于导航模式（导航到 /assets 仍按 asset 处理）', () => {
    expect(classify('/assets/index-abc12345.js', { mode: 'navigate' })).toBe('asset');
  });
});

describe('isBypassPath', () => {
  test('每个前缀本身与其子路径都命中', () => {
    for (const prefix of BYPASS_PREFIXES) {
      expect(isBypassPath(prefix)).toBe(true);
      expect(isBypassPath(`${prefix}/x`)).toBe(true);
    }
  });

  test('应用壳与资源路径不命中', () => {
    expect(isBypassPath(SHELL_URL)).toBe(false);
    expect(isBypassPath('/')).toBe(false);
    expect(isBypassPath('/assets/index-abc12345.js')).toBe(false);
  });

  test('/n/ 不再整段直通', () => {
    expect(isBypassPath('/n/abc123/devices')).toBe(false);
  });
});

describe('isNodeBypassPath', () => {
  test('每个传输层段本身与其子路径都命中', () => {
    for (const name of NODE_BYPASS_SEGMENTS) {
      expect(isNodeBypassPath(`/n/abc123/${name}`)).toBe(true);
      expect(isNodeBypassPath(`/n/abc123/${name}/x`)).toBe(true);
    }
  });

  test('node 根、应用路由与非 /n/ 路径都不命中', () => {
    expect(isNodeBypassPath('/n/abc123')).toBe(false);
    expect(isNodeBypassPath('/n/abc123/')).toBe(false);
    expect(isNodeBypassPath('/n/abc123/devices')).toBe(false);
    expect(isNodeBypassPath('/api/devices')).toBe(false);
    expect(isNodeBypassPath('/')).toBe(false);
  });
});
