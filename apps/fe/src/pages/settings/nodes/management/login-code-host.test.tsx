// 外壳级宿主：没有打开请求时不渲染、也不触发对话框 chunk 的加载。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（不跑 effect）。

import { afterEach, describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { LoginCodeDialogHost, reportLoginCodeLoadFailure } = await import('./login-code-host');
const { closeLoginCodeRequest, requestLoginCode, useLoginCodeRequest } = await import(
  './login-code-request'
);
const { markToasterReady, resetToastQueueForTests } = await import('@vibeterm/ui/toast');
const { default: i18n } = await import('i18next');

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

describe('chunk 加载失败', () => {
  afterEach(() => resetToastQueueForTests());

  test('撤销请求并弹出错误提示', async () => {
    const calls: Array<{ kind: string; message: string }> = [];
    const fake = (kind: string) => (message: string) => calls.push({ kind, message });
    resetToastQueueForTests(async () => ({ toast: { error: fake('error') } }) as never);
    markToasterReady();
    await i18n.init({
      lng: 'en',
      resources: {
        en: { translation: { common: { loadFailedRetry: 'Failed to load. Try again.' } } },
      },
    });
    requestLoginCode('all');
    reportLoginCodeLoadFailure();
    const probe: unknown[] = [];
    renderToStaticMarkup(<Probe onValue={(v) => probe.push(v)} />);
    expect(probe).toEqual([null]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ kind: 'error', message: 'Failed to load. Try again.' }]);
  });
});

function Probe({ onValue }: { onValue: (value: unknown) => void }) {
  onValue(useLoginCodeRequest());
  return null;
}
