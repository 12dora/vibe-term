// 「节点连接代理」卡片：二选一渲染、api 适配、乐观更新失败回滚。无 DOM，静态渲染 + 纯函数。

import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@vibeterm/api-client';
import enUS from '@vibeterm/shared/i18n/locales/en_US.json';
import jaJP from '@vibeterm/shared/i18n/locales/ja_JP.json';
import zhCN from '@vibeterm/shared/i18n/locales/zh_CN.json';
import type { MeshProxyMode } from '@vibeterm/shared/net';
import { renderToStaticMarkup } from 'react-dom/server';
import { MESH_PROXY_SPEC, MeshProxyCard, meshProxyApi } from './mesh-proxy-card';
import {
  type MeshSettingApi,
  MeshSettingChooser,
  applyMeshSettingSelection,
} from './mesh-setting-card';

const zh = zhCN.translation.settings.nodes.meshProxy;
const en = enUS.translation.settings.nodes.meshProxy;
const ja = jaJP.translation.settings.nodes.meshProxy;

function api(mode: MeshProxyMode = 'direct'): MeshSettingApi<MeshProxyMode> {
  return {
    get: () => Promise.resolve(mode),
    set: () => Promise.reject(new Error('unexpected set')),
  };
}

describe('i18n copy', () => {
  test('三语标题与选项文案就位', () => {
    expect(zh.title).toBe('节点连接代理');
    expect(en.title).toBe('Node connection proxy');
    expect(ja.title.length).toBeGreaterThan(0);
    expect(zh.direct.title).toBe('直连');
    expect(zh.system.title).toBe('系统代理');
    expect(zh.system.description).toContain('HTTP_PROXY');
    expect(en.system.description).toContain('HTTP_PROXY');
    expect(ja.system.description).toContain('HTTP_PROXY');
  });
});

describe('MeshProxyCard 渲染', () => {
  test('首次渲染出骨架，选项卡要等加载完成', () => {
    const html = renderToStaticMarkup(<MeshProxyCard api={api()} />);
    expect(html).toContain('data-testid="mesh-proxy-card"');
    expect(html).toContain('data-testid="mesh-proxy-skeleton"');
    expect(html).not.toContain('data-testid="mesh-proxy-direct"');
  });

  test('两张选项卡同一行网格，选中项带 data-selected', () => {
    const html = renderToStaticMarkup(
      <MeshSettingChooser
        spec={MESH_PROXY_SPEC}
        value="system"
        disabled={false}
        onSelect={() => undefined}
      />
    );
    expect(html).toContain('grid gap-3 sm:grid-cols-2');
    expect(html).toMatch(/data-testid="mesh-proxy-system"[^>]*data-selected="true"/);
    expect(html).toMatch(/data-testid="mesh-proxy-direct"[^>]*data-selected="false"/);
  });
});

describe('meshProxyApi', () => {
  test('get / set 取出响应里的 meshProxy', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const client = new ApiClient('', (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      return Promise.resolve(
        new Response(JSON.stringify({ meshProxy: init?.method === 'PUT' ? 'system' : 'direct' }))
      );
    });
    const resolved = meshProxyApi(client);
    expect(await resolved.get()).toBe('direct');
    expect(await resolved.set('system')).toBe('system');
    expect(calls).toEqual([
      { url: '/api/settings/mesh-proxy', method: 'GET' },
      { url: '/api/settings/mesh-proxy', method: 'PUT' },
    ]);
  });
});

describe('applyMeshSettingSelection', () => {
  test('同值不发请求', async () => {
    let set = 0;
    await applyMeshSettingSelection<MeshProxyMode>({
      current: 'direct',
      next: 'direct',
      set: async (mode) => {
        set += 1;
        return mode;
      },
      onOptimistic: () => undefined,
      onCommitted: () => undefined,
      onRollback: () => undefined,
      onError: () => undefined,
    });
    expect(set).toBe(0);
  });

  test('失败：回滚并通知错误', async () => {
    const log: string[] = [];
    await applyMeshSettingSelection<MeshProxyMode>({
      current: 'direct',
      next: 'system',
      set: async () => {
        throw new Error('boom');
      },
      onOptimistic: (mode) => log.push(`opt:${mode}`),
      onCommitted: (mode) => log.push(`ok:${mode}`),
      onRollback: (mode) => log.push(`back:${mode}`),
      onError: (error) => log.push(error instanceof Error ? error.message : 'err'),
    });
    expect(log).toEqual(['opt:system', 'back:direct', 'boom']);
  });
});
