import { describe, expect, test } from 'bun:test';
import { fileDownloadUrl, fileRawUrl, filesApiUrl } from './file-urls';
import {
  SELF_NODE_ID,
  createNodeApiClient,
  isSelfNode,
  nodeAppPath,
  nodePathPrefix,
  nodeWsUrl,
  normalizeNodeId,
  parseNodeIdFromPath,
  resolveNodeUrl,
} from './node-url';

describe('resolveNodeUrl', () => {
  test('self 保持路径原样（与旧路由等价）', () => {
    expect(resolveNodeUrl(SELF_NODE_ID, '/api/devices')).toBe('/api/devices');
    expect(resolveNodeUrl('self', '/ws')).toBe('/ws');
  });

  test('空 nodeId 与 undefined 归一为 self', () => {
    expect(resolveNodeUrl('', '/api/devices')).toBe('/api/devices');
    expect(resolveNodeUrl(undefined, '/api/devices')).toBe('/api/devices');
    expect(normalizeNodeId(undefined)).toBe('self');
    expect(normalizeNodeId('node-a')).toBe('node-a');
    expect(isSelfNode('self')).toBe(true);
    expect(isSelfNode('node-a')).toBe(false);
  });

  test('非 self 加 /n/<id> 前缀', () => {
    expect(resolveNodeUrl('node-a', '/api/devices')).toBe('/n/node-a/api/devices');
    expect(resolveNodeUrl('node-a', '/ws')).toBe('/n/node-a/ws');
  });

  test('nodeId 做 URL 编码', () => {
    expect(resolveNodeUrl('a/b', '/api/x')).toBe('/n/a%2Fb/api/x');
  });

  test('空 path 得到可直接做 ApiClient baseUrl 的前缀', () => {
    expect(resolveNodeUrl('node-a', '')).toBe('/n/node-a');
    expect(resolveNodeUrl('self', '')).toBe('');
    expect(nodePathPrefix('node-a')).toBe('/n/node-a');
    expect(nodePathPrefix('self')).toBe('');
  });
});

describe('nodeWsUrl', () => {
  test('http 用 ws:，https 用 wss:', () => {
    expect(nodeWsUrl('self', { protocol: 'http:', host: 'example.com:9663' })).toBe(
      'ws://example.com:9663/ws'
    );
    expect(nodeWsUrl('self', { protocol: 'https:', host: 'example.com' })).toBe(
      'wss://example.com/ws'
    );
  });

  test('非 self 带 /n/<id> 前缀', () => {
    expect(nodeWsUrl('node-b', { protocol: 'https:', host: 'example.com' })).toBe(
      'wss://example.com/n/node-b/ws'
    );
  });
});

describe('createNodeApiClient', () => {
  test('baseUrl 为 node 前缀，端点路径拼接后带前缀', () => {
    expect(createNodeApiClient('self').url('/api/devices')).toBe('/api/devices');
    expect(createNodeApiClient('node-a').url('/api/devices')).toBe('/n/node-a/api/devices');
  });
});

describe('nodeAppPath / parseNodeIdFromPath', () => {
  test('应用内路由前缀与解析互逆', () => {
    expect(nodeAppPath('self', '/devices/d1')).toBe('/devices/d1');
    expect(nodeAppPath('node-a', '/devices/d1')).toBe('/n/node-a/devices/d1');
    expect(parseNodeIdFromPath('/devices/d1')).toBe('self');
    expect(parseNodeIdFromPath('/n/node-a/devices/d1')).toBe('node-a');
    expect(parseNodeIdFromPath('/n/node-a')).toBe('node-a');
    expect(parseNodeIdFromPath('/n/self/settings')).toBe('self');
  });
});

describe('file-urls 带 nodeId', () => {
  test('self 的 raw / download URL 与旧行为一致', () => {
    expect(fileRawUrl('self', 'r1', '/a/b.png')).toBe('/api/files/raw?rootId=r1&path=%2Fa%2Fb.png');
    expect(fileDownloadUrl('self', 'r1', '/a/b.png')).toBe(
      '/api/files/download?rootId=r1&path=%2Fa%2Fb.png'
    );
  });

  test('非 self 带 /n/<id> 前缀', () => {
    expect(fileRawUrl('node-a', 'r1', '/a/b.png')).toBe(
      '/n/node-a/api/files/raw?rootId=r1&path=%2Fa%2Fb.png'
    );
    expect(fileRawUrl('node-a', 'r1', '/a/b.png', true)).toBe(
      '/n/node-a/api/files/raw?rootId=r1&path=%2Fa%2Fb.png&download=1'
    );
    expect(fileDownloadUrl('node-a', 'r1', '/a/b.png')).toBe(
      '/n/node-a/api/files/download?rootId=r1&path=%2Fa%2Fb.png'
    );
  });

  test('filesApiUrl 仍为相对路径（由 ApiClient baseUrl 注入前缀）', () => {
    expect(filesApiUrl('stat', 'r1', '/a')).toBe('/api/files/stat?rootId=r1&path=%2Fa');
  });
});
