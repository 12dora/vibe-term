// 悬停数据预取：选哪些查询、以及「每次进页面每个标签只发一次」。
// 不起 QueryClient，用假的 prefetchQuery 记录调用。

import { describe, expect, test } from 'bun:test';
import type { QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@tmex/api-client';
import { PREFETCHABLE_TABS, prefetchTabData, tabPrefetchSpecs } from './data-prefetch';

const apiClient = { fetch: async () => new Response('{}') } as unknown as ApiClient;

function fakeQueryClient() {
  const calls: { queryKey: readonly unknown[] }[] = [];
  const client = {
    prefetchQuery: (options: { queryKey: readonly unknown[] }) => {
      calls.push({ queryKey: options.queryKey });
      return Promise.resolve();
    },
  } as unknown as QueryClient;
  return { client, calls };
}

const ALL_TABS = [
  'general',
  'devicesAndFiles',
  'nodes',
  'notifications',
  'ai',
  'terminal',
  'remoteAccess',
];

describe('tabPrefetchSpecs', () => {
  test('AI 标签预取 providers 与 settings 两条', () => {
    const specs = tabPrefetchSpecs('ai', apiClient);
    expect(specs.map((s) => s.queryKey)).toEqual([['llm-providers'], ['llm-settings']]);
  });

  test('终端标签预取快捷键设置', () => {
    const specs = tabPrefetchSpecs('terminal', apiClient);
    expect(specs.map((s) => s.queryKey)).toEqual([['terminal-shortcuts']]);
  });

  test('其余标签没有可安全预取的查询（queryFn 在各自的 lazy chunk 里）', () => {
    for (const tab of ALL_TABS) {
      if (PREFETCHABLE_TABS.includes(tab)) continue;
      expect(tabPrefetchSpecs(tab, apiClient)).toEqual([]);
    }
  });

  test('PREFETCHABLE_TABS 与实际有 spec 的标签一致', () => {
    const withSpecs = ALL_TABS.filter((tab) => tabPrefetchSpecs(tab, apiClient).length > 0);
    expect(withSpecs.sort()).toEqual([...PREFETCHABLE_TABS].sort());
  });
});

describe('prefetchTabData', () => {
  test('把该标签的每条查询都交给 prefetchQuery', () => {
    const { client, calls } = fakeQueryClient();
    prefetchTabData(client, 'ai', apiClient, new Set());
    expect(calls.map((c) => c.queryKey)).toEqual([['llm-providers'], ['llm-settings']]);
  });

  test('同一标签重复触发只预取一次', () => {
    const { client, calls } = fakeQueryClient();
    const done = new Set<string>();
    prefetchTabData(client, 'terminal', apiClient, done);
    prefetchTabData(client, 'terminal', apiClient, done);
    prefetchTabData(client, 'terminal', apiClient, done);
    expect(calls).toHaveLength(1);
  });

  test('没有 spec 的标签既不发请求，也不占用去重名额', () => {
    const { client, calls } = fakeQueryClient();
    const done = new Set<string>();
    prefetchTabData(client, 'nodes', apiClient, done);
    expect(calls).toHaveLength(0);
    expect(done.size).toBe(0);
  });

  test('不同标签各自预取，互不影响', () => {
    const { client, calls } = fakeQueryClient();
    const done = new Set<string>();
    prefetchTabData(client, 'ai', apiClient, done);
    prefetchTabData(client, 'terminal', apiClient, done);
    expect(calls).toHaveLength(3);
    expect(done).toEqual(new Set(['ai', 'terminal']));
  });

  test('prefetchQuery 失败不外抛（面板挂载时会自己重发）', async () => {
    const client = {
      prefetchQuery: () => Promise.reject(new Error('网络断了')),
    } as unknown as QueryClient;
    expect(() => prefetchTabData(client, 'terminal', apiClient, new Set())).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
