import { describe, expect, test } from 'bun:test';
import type { TransferJobView } from '@vibeterm/panels/files/transfers';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DialogNodeOption } from '../dialog-nodes';
import { TransferRow, endpointLabel } from './transfer-list';
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

function jobView(patch: Partial<TransferJobView> = {}): TransferJobView {
  return {
    key: 'self:j1',
    kind: 'node',
    nodeId: 'self',
    jobId: 'j1',
    fromNodeId: ENTRY,
    toNodeId: REMOTE,
    title: 'a.bin',
    state: 'running',
    progress: { transferredBytes: 1024, totalBytes: 2048, ratePerSec: 4096, etaSec: 12 },
    pct: 50,
    path: null,
    itemStates: [],
    itemsDone: 0,
    itemsTotal: 1,
    createdAt: 0,
    updatedAt: 0,
    finishedAt: null,
    cancellable: true,
    ...patch,
  };
}

describe('传输进度行的宽度', () => {
  test('已传 / 总量与速率 / 剩余时间各自定宽，位数变化不挤动端点名', () => {
    const html = renderToStaticMarkup(<TransferRow view={jobView()} options={OPTIONS} />);
    expect(html).toContain('data-slot="byte-rate"');
    // 21ch = `1023.9 MB / 1023.9 MB`；11ch = `1023.9 MB/s`；8ch = 封顶的 `99:59:59`
    expect(html).toContain('min-w-[21ch]');
    expect(html).toContain('min-w-[11ch]');
    expect(html).toContain('min-w-[8ch]');
    // 固定一位小数、单位从 KB 起
    expect(html).toContain('1.0 KB / 2.0 KB');
    expect(html).toContain('4.0 KB/s');
    expect(html).toContain('0:12');
  });

  test('终态行不摆速率与剩余时间', () => {
    const html = renderToStaticMarkup(
      <TransferRow view={jobView({ state: 'done', pct: 100 })} options={OPTIONS} />
    );
    expect(html).not.toContain('KB/s');
  });
});
