// 「延迟优化」卡片：三选一渲染、乐观更新失败回滚。无 DOM，静态渲染 + 纯函数。

import { describe, expect, test } from 'bun:test';
import enUS from '@vibeterm/shared/i18n/locales/en_US.json';
import jaJP from '@vibeterm/shared/i18n/locales/ja_JP.json';
import zhCN from '@vibeterm/shared/i18n/locales/zh_CN.json';
import type { MeshRouteMode } from '@vibeterm/shared/net';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type RouteModeApi,
  RouteModeCard,
  RouteModeChooser,
  applyRouteModeSelection,
} from './route-mode-card';

const zh = zhCN.translation.settings.nodes.routeMode;
const en = enUS.translation.settings.nodes.routeMode;
const ja = jaJP.translation.settings.nodes.routeMode;

function api(mode: MeshRouteMode = 'auto'): RouteModeApi {
  return {
    get: () => Promise.resolve({ mode }),
    set: () => Promise.reject(new Error('unexpected set')),
  };
}

function render(current: RouteModeApi = api()): string {
  return renderToStaticMarkup(<RouteModeCard api={current} />);
}

describe('i18n copy', () => {
  test('三语标题与选项文案就位', () => {
    expect(zh.title).toBe('延迟优化');
    expect(en.title).toBe('Latency optimisation');
    expect(ja.title).toBe('遅延最適化');
    expect(zh.auto.title).toBe('智能');
    expect(en.auto.title).toBe('Smart');
    expect(ja.auto.title).toBe('スマート');
    expect(zh.direct.title).toBe('直连');
    expect(en.direct.title).toBe('Direct');
    expect(zh.relay.title).toBe('中继');
    expect(en.relay.title).toBe('Relay');
    expect(zh.auto.description).toContain('文件传输优先直连');
    expect(en.auto.description).toContain('file transfer prefers direct');
    expect(ja.auto.description).toContain('ファイル転送');
  });
});

describe('RouteModeCard 渲染', () => {
  test('首次渲染出骨架，三张选项卡要等加载完成', () => {
    const html = render();
    expect(html).toContain('data-testid="mesh-route-mode-card"');
    expect(html).toContain('data-testid="mesh-route-mode-skeleton"');
    expect(html).not.toContain('data-testid="mesh-route-mode-auto"');
  });

  test('三张选项卡同一行网格，选中项带 data-selected', () => {
    const html = renderToStaticMarkup(
      <RouteModeChooser mode="direct" disabled={false} onSelect={() => undefined} />
    );
    expect(html).toContain('grid gap-3 sm:grid-cols-3');
    expect(html).toContain('data-testid="mesh-route-mode-auto"');
    expect(html).toContain('data-testid="mesh-route-mode-direct"');
    expect(html).toContain('data-testid="mesh-route-mode-relay"');
    expect(html).toMatch(/data-testid="mesh-route-mode-direct"[^>]*data-selected="true"/);
    expect(html).toMatch(/data-testid="mesh-route-mode-auto"[^>]*data-selected="false"/);
  });
});

describe('applyRouteModeSelection', () => {
  test('同值不发请求', async () => {
    let set = 0;
    await applyRouteModeSelection({
      current: 'auto',
      next: 'auto',
      set: async () => {
        set += 1;
        return { mode: 'auto' };
      },
      onOptimistic: () => undefined,
      onCommitted: () => undefined,
      onRollback: () => undefined,
      onError: () => undefined,
    });
    expect(set).toBe(0);
  });

  test('成功：乐观切过去并以服务端结果落定', async () => {
    const log: string[] = [];
    await applyRouteModeSelection({
      current: 'auto',
      next: 'relay',
      set: async (mode) => ({ mode }),
      onOptimistic: (mode) => log.push(`opt:${mode}`),
      onCommitted: (mode) => log.push(`ok:${mode}`),
      onRollback: (mode) => log.push(`back:${mode}`),
      onError: () => log.push('err'),
    });
    expect(log).toEqual(['opt:relay', 'ok:relay']);
  });

  test('失败：回滚并通知错误', async () => {
    const log: string[] = [];
    await applyRouteModeSelection({
      current: 'direct',
      next: 'relay',
      set: async () => {
        throw new Error('boom');
      },
      onOptimistic: (mode) => log.push(`opt:${mode}`),
      onCommitted: (mode) => log.push(`ok:${mode}`),
      onRollback: (mode) => log.push(`back:${mode}`),
      onError: (error) => log.push(error instanceof Error ? error.message : 'err'),
    });
    expect(log).toEqual(['opt:relay', 'back:direct', 'boom']);
  });
});
