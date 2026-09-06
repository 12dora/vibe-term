import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DialogNodeOption } from '../dialog-nodes';
import { PortMapTable, targetNodeName } from './portmap-table';
import type { PortMapRow } from './use-portmap-list';

const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

const OPTIONS: DialogNodeOption[] = [
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

function row(targetNodeId: string, patch: Partial<PortMapRow> = {}): PortMapRow {
  return {
    id: 'm1',
    name: 'db',
    listenHost: '127.0.0.1',
    listenPort: 8080,
    targetNodeId,
    targetHost: '127.0.0.1',
    targetPort: 5432,
    paused: false,
    state: 'listening',
    activeConnections: 0,
    totalConnections: 0,
    bytesIn: 0,
    bytesOut: 0,
    createdAt: 0,
    updatedAt: 0,
    nodeId: 'self',
    nodeName: '本机',
    ...patch,
  };
}

describe('targetNodeName', () => {
  test('按真实 mesh id 解析成节点名', () => {
    expect(targetNodeName(row(REMOTE), OPTIONS)).toBe('studio');
  });

  test('节点已不在 mesh 里时退回短 id', () => {
    expect(targetNodeName(row('abcdef0123456789'), OPTIONS)).toBe('abcdef01');
  });
});

describe('流量列的宽度', () => {
  test('收发两个读数各自定宽，列本身也定死', () => {
    const html = renderToStaticMarkup(
      <PortMapTable
        rows={[row(REMOTE, { bytesIn: 1024, bytesOut: 20 * 1024 * 1024 })]}
        options={OPTIONS}
        busyId={null}
        onToggle={() => undefined}
        onDelete={() => undefined}
      />
    );
    expect(html).toContain('data-testid="portmap-bytes-in-m1"');
    expect(html).toContain('data-testid="portmap-bytes-out-m1"');
    expect(html).toContain('w-[15rem] min-w-[15rem]');
    expect(html).toContain('min-w-[11ch]');
    // 固定一位小数、单位从 KB 起：0 字节也不塌成 `0 B`
    expect(html).toContain('1.0 KB');
    expect(html).toContain('20.0 MB');
  });

  test('方向符号对读屏无意义，收 / 发各配一条 sr-only 文案', () => {
    const html = renderToStaticMarkup(
      <PortMapTable
        rows={[row(REMOTE)]}
        options={OPTIONS}
        busyId={null}
        onToggle={() => undefined}
        onDelete={() => undefined}
      />
    );
    expect(html).toContain('<span class="sr-only">common.direction.in</span>');
    expect(html).toContain('<span class="sr-only">common.direction.out</span>');
    expect(html).toContain('aria-hidden="true">↓</span>');
    expect(html).toContain('aria-hidden="true">↑</span>');
  });

  test('零流量摆 0.0 KB，位数与有流量时一致', () => {
    const html = renderToStaticMarkup(
      <PortMapTable
        rows={[row(REMOTE)]}
        options={OPTIONS}
        busyId={null}
        onToggle={() => undefined}
        onDelete={() => undefined}
      />
    );
    expect(html).toContain('0.0 KB');
    expect(html).not.toContain('0 B');
  });
});
