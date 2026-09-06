import { describe, expect, test } from 'bun:test';
import type { DialogNodeOption } from '../dialog-nodes';
import { endpointLabel } from './transfer-list';
import { fileListQueryOptions, fileRootsQueryOptions } from './transfer-queries';

const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

const OPTIONS: DialogNodeOption[] = [
  {
    id: 'self',
    meshId: ENTRY,
    name: '本机',
    online: true,
    loggedIn: true,
    isSelf: true,
    usable: true,
  },
  {
    id: REMOTE,
    meshId: REMOTE,
    name: 'studio',
    online: true,
    loggedIn: true,
    isSelf: false,
    usable: true,
  },
];

describe('endpointLabel', () => {
  test('服务端给的是真实 mesh id，按 meshId 解析成名字', () => {
    expect(endpointLabel(ENTRY, OPTIONS, '浏览器')).toBe('本机');
    expect(endpointLabel(REMOTE, OPTIONS, '浏览器')).toBe('studio');
  });

  test('浏览器任务的一端用固定文案', () => {
    expect(endpointLabel('browser', OPTIONS, '浏览器')).toBe('浏览器');
  });

  test('浏览器任务另一端存的是运行时 id，也能解析', () => {
    expect(endpointLabel('self', OPTIONS, '浏览器')).toBe('本机');
  });

  test('已经不在 mesh 里的节点退回短 id', () => {
    expect(endpointLabel('abcdef0123456789', OPTIONS, '浏览器')).toBe('abcdef01');
  });
});

describe('查询选项', () => {
  test('查询键带 nodeId，两个节点的缓存互不覆盖', () => {
    const client = { fetch: () => Promise.resolve(new Response('')) } as never;
    expect(fileRootsQueryOptions('self', client).queryKey).toEqual([
      'devices-transfer',
      'roots',
      'self',
    ]);
    expect(fileListQueryOptions(REMOTE, 'r1', '/a', client).queryKey).toEqual([
      'devices-transfer',
      'list',
      REMOTE,
      'r1',
      '/a',
    ]);
  });
});
