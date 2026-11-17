// 外壳级宿主：没有打开请求时不渲染、也不触发对话框 chunk 的加载。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（不跑 effect）。

import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { LoginCodeDialogHost } = await import('./login-code-host');
const { closeLoginCodeRequest, requestLoginCode } = await import('./login-code-request');

describe('LoginCodeDialogHost', () => {
  test('无请求不渲染，且不加载对话框 chunk', () => {
    let loads = 0;
    const load = () => {
      loads += 1;
      return Promise.reject(new Error('unused'));
    };
    expect(renderToStaticMarkup(<LoginCodeDialogHost load={load} />)).toBe('');
    expect(loads).toBe(0);
  });

  test('有请求但 chunk 尚未就绪时先不渲染（静态渲染不跑 effect）', () => {
    requestLoginCode('all');
    try {
      const load = () => new Promise<never>(() => undefined);
      expect(renderToStaticMarkup(<LoginCodeDialogHost load={load} />)).toBe('');
    } finally {
      closeLoginCodeRequest();
    }
  });
});
