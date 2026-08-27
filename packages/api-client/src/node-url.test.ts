import { describe, expect, test } from 'bun:test';
import { fileDownloadUrl, fileRawUrl, filesApiUrl } from './file-urls';
import {
  CLIENT_NONCE_BYTES,
  InvalidNodeIdError,
  SELF_NODE_ID,
  assertNodeId,
  createNodeApiClient,
  createNodeWsUrlSource,
  generateClientNonce,
  isSelfNode,
  isValidNodeId,
  nodeAppPath,
  nodePathPrefix,
  nodeWsUrl,
  normalizeNodeId,
  parseNodeIdFromPath,
  resolveNodeUrl,
} from './node-url';

/** node id 是 16 字节 → 32 位小写 hex。 */
const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const NODE_B = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';

describe('assertNodeId', () => {
  test('self / 空 / undefined 都归一为 self', () => {
    expect(assertNodeId('self')).toBe(SELF_NODE_ID);
    expect(assertNodeId('')).toBe(SELF_NODE_ID);
    expect(assertNodeId(undefined)).toBe(SELF_NODE_ID);
    expect(assertNodeId(null)).toBe(SELF_NODE_ID);
  });

  test('接受规范的 32 位小写 hex', () => {
    expect(assertNodeId(NODE_A)).toBe(NODE_A);
    expect(isValidNodeId(NODE_A)).toBe(true);
  });

  test('路径穿越形态一律拒绝：`..`、`%2e%2e`、`a/b`', () => {
    expect(() => assertNodeId('..')).toThrow(InvalidNodeIdError);
    expect(() => assertNodeId('%2e%2e')).toThrow(InvalidNodeIdError);
    expect(() => assertNodeId('../..')).toThrow(InvalidNodeIdError);
    expect(() => assertNodeId('a/b')).toThrow(InvalidNodeIdError);
    expect(isValidNodeId('..')).toBe(false);
  });

  test('大写 hex、长度不对、非 hex 字符都拒绝', () => {
    expect(() => assertNodeId(NODE_A.toUpperCase())).toThrow(InvalidNodeIdError);
    expect(() => assertNodeId('0a0a')).toThrow(InvalidNodeIdError);
    expect(() => assertNodeId(`${NODE_A}0`)).toThrow(InvalidNodeIdError);
    expect(() => assertNodeId('node-a')).toThrow(InvalidNodeIdError);
    expect(() => assertNodeId('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toThrow(InvalidNodeIdError);
  });
});

describe('resolveNodeUrl', () => {
  test('self 保持路径原样（与旧路由等价）', () => {
    expect(resolveNodeUrl(SELF_NODE_ID, '/api/devices')).toBe('/api/devices');
    expect(resolveNodeUrl('self', '/ws')).toBe('/ws');
  });

  test('空 nodeId 与 undefined 归一为 self', () => {
    expect(resolveNodeUrl('', '/api/devices')).toBe('/api/devices');
    expect(resolveNodeUrl(undefined, '/api/devices')).toBe('/api/devices');
    expect(normalizeNodeId(undefined)).toBe('self');
    expect(normalizeNodeId(NODE_A)).toBe(NODE_A);
    expect(isSelfNode('self')).toBe(true);
    expect(isSelfNode(NODE_A)).toBe(false);
  });

  test('非 self 加 /n/<id> 前缀', () => {
    expect(resolveNodeUrl(NODE_A, '/api/devices')).toBe(`/n/${NODE_A}/api/devices`);
    expect(resolveNodeUrl(NODE_A, '/ws')).toBe(`/n/${NODE_A}/ws`);
  });

  test('非法 nodeId 直接抛，绝不靠 encodeURIComponent 兜底', () => {
    // `encodeURIComponent('..')` 就是 `..`，会拼出 `/n/../api/x` 并在规范化后越界。
    expect(() => resolveNodeUrl('..', '/api/x')).toThrow(InvalidNodeIdError);
    expect(() => resolveNodeUrl('a/b', '/api/x')).toThrow(InvalidNodeIdError);
  });

  test('空 path 得到可直接做 ApiClient baseUrl 的前缀', () => {
    expect(resolveNodeUrl(NODE_A, '')).toBe(`/n/${NODE_A}`);
    expect(resolveNodeUrl('self', '')).toBe('');
    expect(nodePathPrefix(NODE_A)).toBe(`/n/${NODE_A}`);
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
    expect(nodeWsUrl(NODE_B, { protocol: 'https:', host: 'example.com' })).toBe(
      `wss://example.com/n/${NODE_B}/ws`
    );
  });

  test('非法 nodeId 抛错（不会造出越界的 ws URL）', () => {
    expect(() => nodeWsUrl('..', { protocol: 'https:', host: 'example.com' })).toThrow(
      InvalidNodeIdError
    );
  });

  test('带 cid 时拼 `?cid=`，并做 URL 编码', () => {
    expect(nodeWsUrl('self', { protocol: 'https:', host: 'h', cid: 'abc' })).toBe(
      'wss://h/ws?cid=abc'
    );
    expect(nodeWsUrl(NODE_B, { protocol: 'https:', host: 'h', cid: 'a/b+c=' })).toBe(
      `wss://h/n/${NODE_B}/ws?cid=a%2Fb%2Bc%3D`
    );
    // 空 cid 不拼空 query
    expect(nodeWsUrl('self', { protocol: 'https:', host: 'h', cid: '' })).toBe('wss://h/ws');
    expect(nodeWsUrl('self', { protocol: 'https:', host: 'h', cid: null })).toBe('wss://h/ws');
  });
});

describe('generateClientNonce', () => {
  test('b64url 字符集、长度覆盖 16 字节，且每次都不同', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const nonce = generateClientNonce();
      expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
      // 16 字节 → 22 个 b64url 字符（无 padding）
      expect(nonce.length).toBe(Math.ceil((CLIENT_NONCE_BYTES * 8) / 6));
      seen.add(nonce);
    }
    expect(seen.size).toBe(64);
  });
});

describe('createNodeWsUrlSource', () => {
  test('每建一条 socket 换一个 nonce，cid() 跟着当前 socket 走', () => {
    const source = createNodeWsUrlSource(NODE_A, { protocol: 'https:', host: 'h' });
    // 还没建过 socket：没有 nonce 可用，调用方退化成不带 cid 的查询
    expect(source.cid()).toBeNull();

    const first = source.nextUrl();
    const firstCid = source.cid();
    expect(firstCid).not.toBeNull();
    expect(first).toBe(`wss://h/n/${NODE_A}/ws?cid=${firstCid}`);

    // 重连：新 socket = 新 nonce = 新的服务端 connectionId
    const second = source.nextUrl();
    expect(source.cid()).not.toBe(firstCid);
    expect(second).not.toBe(first);
  });

  test('不同连接之间 nonce 互不相同', () => {
    const a = createNodeWsUrlSource(NODE_A, { protocol: 'https:', host: 'h' });
    const b = createNodeWsUrlSource(NODE_A, { protocol: 'https:', host: 'h' });
    a.nextUrl();
    b.nextUrl();
    expect(a.cid()).not.toBe(b.cid());
  });
});

describe('createNodeApiClient', () => {
  test('baseUrl 为 node 前缀，端点路径拼接后带前缀', () => {
    expect(createNodeApiClient('self').url('/api/devices')).toBe('/api/devices');
    expect(createNodeApiClient(NODE_A).url('/api/devices')).toBe(`/n/${NODE_A}/api/devices`);
  });
});

describe('nodeAppPath / parseNodeIdFromPath', () => {
  test('应用内路由前缀与解析互逆', () => {
    expect(nodeAppPath('self', '/devices/d1')).toBe('/devices/d1');
    expect(nodeAppPath(NODE_A, '/devices/d1')).toBe(`/n/${NODE_A}/devices/d1`);
    expect(parseNodeIdFromPath('/devices/d1')).toBe('self');
    expect(parseNodeIdFromPath(`/n/${NODE_A}/devices/d1`)).toBe(NODE_A);
    expect(parseNodeIdFromPath(`/n/${NODE_A}`)).toBe(NODE_A);
    expect(parseNodeIdFromPath('/n/self/settings')).toBe('self');
  });

  test('前缀不是规范 node id 时按 self 处理，不把脏值带进后续拼接', () => {
    expect(parseNodeIdFromPath('/n/../api/x')).toBe('self');
    expect(parseNodeIdFromPath('/n/%2e%2e/api/x')).toBe('self');
    expect(parseNodeIdFromPath(`/n/${NODE_A.toUpperCase()}/api/x`)).toBe('self');
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
    expect(fileRawUrl(NODE_A, 'r1', '/a/b.png')).toBe(
      `/n/${NODE_A}/api/files/raw?rootId=r1&path=%2Fa%2Fb.png`
    );
    expect(fileRawUrl(NODE_A, 'r1', '/a/b.png', true)).toBe(
      `/n/${NODE_A}/api/files/raw?rootId=r1&path=%2Fa%2Fb.png&download=1`
    );
    expect(fileDownloadUrl(NODE_A, 'r1', '/a/b.png')).toBe(
      `/n/${NODE_A}/api/files/download?rootId=r1&path=%2Fa%2Fb.png`
    );
  });

  test('filesApiUrl 仍为相对路径（由 ApiClient baseUrl 注入前缀）', () => {
    expect(filesApiUrl('stat', 'r1', '/a')).toBe('/api/files/stat?rootId=r1&path=%2Fa');
  });
});
