// 悬停数据预取：选哪些查询、以及「每次进页面每个标签只发一次」。
// 不起 QueryClient，用假的 prefetchQuery 记录调用。

import { describe, expect, test } from 'bun:test';
import type { QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@tmex/api-client';
import {
  PREFETCHABLE_TABS,
  SETTINGS_STALE_MS,
  prefetchTabData,
  tabPrefetchSpecs,
} from './data-prefetch';

const apiClient = { fetch: async () => new Response('{}') } as unknown as ApiClient;

function fakeQueryClient() {
  const calls: { queryKey: readonly unknown[]; staleTime?: number }[] = [];
  const client = {
    prefetchQuery: (options: { queryKey: readonly unknown[]; staleTime?: number }) => {
      calls.push({ queryKey: options.queryKey, staleTime: options.staleTime });
      return Promise.resolve();
    },
  } as unknown as QueryClient;
  return { client, calls };
}

const ALL_TABS = [
  'general',
  'devicesAndFiles',
  'nodes',
  'share',
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

  test('远程访问标签预取隧道状态（首屏被它整块挡住）', () => {
    const specs = tabPrefetchSpecs('remoteAccess', apiClient);
    expect(specs.map((s) => s.queryKey)).toEqual([['tunnel-status']]);
  });

  test('分享标签预取分享列表（首屏两张表都等它）', () => {
    const specs = tabPrefetchSpecs('share', apiClient);
    expect(specs.map((s) => s.queryKey)).toEqual([['share', null, null]]);
    expect(specs[0].staleTime).toBeUndefined();
  });

  test('节点标签预取本机运行态与 TLS 状态', () => {
    const specs = tabPrefetchSpecs('nodes', apiClient);
    expect(specs.map((s) => s.queryKey)).toEqual([['local-status'], ['tls-status']]);
  });

  test('设置类数据给长 staleTime，实时状态不给（走默认值，各自还带轮询）', () => {
    for (const tab of ['ai', 'terminal']) {
      for (const spec of tabPrefetchSpecs(tab, apiClient)) {
        expect(spec.staleTime).toBe(SETTINGS_STALE_MS);
      }
    }
    for (const tab of ['nodes', 'remoteAccess']) {
      for (const spec of tabPrefetchSpecs(tab, apiClient)) {
        expect(spec.staleTime).toBeUndefined();
      }
    }
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

  test('状态标签的两条查询都交给 prefetchQuery（实时数据不带 staleTime）', () => {
    const { client, calls } = fakeQueryClient();
    prefetchTabData(client, 'nodes', apiClient, new Set());
    expect(calls).toEqual([
      { queryKey: ['local-status'], staleTime: undefined },
      { queryKey: ['tls-status'], staleTime: undefined },
    ]);
  });

  test('没有 spec 的标签既不发请求，也不占用去重名额', () => {
    const { client, calls } = fakeQueryClient();
    const done = new Set<string>();
    prefetchTabData(client, 'general', apiClient, done);
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
