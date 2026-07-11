import { describe, expect, test } from 'bun:test';
import { FeatureSet } from './capabilities';
import { ApiClient, defaultApiClient, parseApiError } from './client';

describe('ApiClient', () => {
  test('默认实例 baseUrl 为空（相对路径，同源）', () => {
    expect(defaultApiClient.baseUrl).toBe('');
    expect(defaultApiClient.url('/api/x')).toBe('/api/x');
  });

  test('注入 baseUrl 后 url 拼接前缀', () => {
    const client = new ApiClient('http://gw.example:1234');
    expect(client.url('/api/agent/sessions')).toBe('http://gw.example:1234/api/agent/sessions');
  });
});

describe('parseApiError', () => {
  test('解析 JSON error 字段', async () => {
    const res = new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    expect(await parseApiError(res, 'fallback')).toBe('boom');
  });

  test('非 JSON 响应回退 fallback', async () => {
    const res = new Response('oops', { status: 500 });
    expect(await parseApiError(res, 'fallback')).toBe('fallback');
  });

  test('JSON 无 error 字段回退 fallback', async () => {
    const res = new Response(JSON.stringify({ ok: false }), { status: 500 });
    expect(await parseApiError(res, 'fallback')).toBe('fallback');
  });
});

describe('FeatureSet', () => {
  test('has/hasAll/hasAny 判定', () => {
    const fs = new FeatureSet(['tmex-ws-borsh-v1', 'tmex-agent-v1']);
    expect(fs.has('tmex-agent-v1')).toBe(true);
    expect(fs.has('tmex-split-v1')).toBe(false);
    expect(fs.hasAll('tmex-ws-borsh-v1', 'tmex-agent-v1')).toBe(true);
    expect(fs.hasAll('tmex-ws-borsh-v1', 'tmex-split-v1')).toBe(false);
    expect(fs.hasAny('tmex-split-v1', 'tmex-agent-v1')).toBe(true);
    expect(fs.hasAny('tmex-split-v1')).toBe(false);
  });

  test('empty 与 list', () => {
    expect(FeatureSet.empty().list()).toEqual([]);
    expect(new FeatureSet(['a', 'a', 'b']).list().sort()).toEqual(['a', 'b']);
  });
});
