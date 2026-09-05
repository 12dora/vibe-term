// 分享端点的 URL 形状与请求方法：写错一个字就是 404 或写进别的资源。

import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import {
  SHARE_SETTINGS_PATH,
  deleteShare,
  fetchShareLogPage,
  fetchShareSettings,
  saveShareSettings,
  shareLogPath,
  shareLogQueryKey,
  shareResourcePath,
  shareSettingsQueryKey,
} from './share-api';

function recordingClient(body: unknown = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new ApiClient('/n/abc', (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    );
  });
  return { client, calls };
}

describe('路径拼装', () => {
  test('单条分享挂在 /api/share/<id> 下', () => {
    expect(shareResourcePath('abc')).toBe('/api/share/abc');
  });

  test('分享 id 里的特殊字符转义（base64url 之外的输入不该拼坏路径）', () => {
    expect(shareResourcePath('a/b?c')).toBe('/api/share/a%2Fb%3Fc');
  });

  test('日志分页参数只在给了值时出现', () => {
    expect(shareLogPath('abc')).toBe('/api/share/abc/log');
    expect(shareLogPath('abc', { after: 0 })).toBe('/api/share/abc/log?after=0');
    expect(shareLogPath('abc', { after: 12, limit: 500 })).toBe(
      '/api/share/abc/log?after=12&limit=500'
    );
    expect(shareLogPath('abc', { limit: 500 })).toBe('/api/share/abc/log?limit=500');
  });

  test('设置端点是单一路径', () => {
    expect(SHARE_SETTINGS_PATH).toBe('/api/share/settings');
  });
});

describe('查询键', () => {
  test('设置与日志各自独立，日志按分享分片', () => {
    expect(shareSettingsQueryKey).toEqual(['share-settings']);
    expect(shareLogQueryKey('abc')).toEqual(['share-log', 'abc']);
    expect(shareLogQueryKey('def')).not.toEqual(shareLogQueryKey('abc'));
  });
});

describe('请求', () => {
  test('读设置走 GET，路径带上 client 的 node 前缀', async () => {
    const { client, calls } = recordingClient({ recordLogs: true });
    await fetchShareSettings(client);
    expect(calls[0].url).toBe('/n/abc/api/share/settings');
    expect(calls[0].init?.method).toBeUndefined();
  });

  test('存设置走 PUT，body 是 JSON', async () => {
    const { client, calls } = recordingClient({ recordLogs: false });
    await saveShareSettings(client, { recordLogs: false });
    expect(calls[0].url).toBe('/n/abc/api/share/settings');
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[0].init?.body).toBe('{"recordLogs":false}');
  });

  test('删除历史走 DELETE', async () => {
    const { client, calls } = recordingClient();
    await deleteShare(client, 'abc');
    expect(calls[0].url).toBe('/n/abc/api/share/abc');
    expect(calls[0].init?.method).toBe('DELETE');
  });

  test('取日志页把游标带进 query', async () => {
    const { client, calls } = recordingClient({ entries: [], nextAfter: null, total: 0 });
    await fetchShareLogPage(client, 'abc', { after: 7 });
    expect(calls[0].url).toBe('/n/abc/api/share/abc/log?after=7');
  });

  test('非 2xx 抛出服务端给的原因', async () => {
    const client = new ApiClient('', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'SHARE_NOT_FOUND' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    expect(fetchShareLogPage(client, 'abc')).rejects.toThrow('SHARE_NOT_FOUND');
  });
});
