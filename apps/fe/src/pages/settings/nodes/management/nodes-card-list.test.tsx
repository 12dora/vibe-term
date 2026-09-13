// 窄屏（sm 以下）的节点记录卡：表格整张换成卡片，但 testid 与动作与宽表一一对应。
// 无 DOM 测试环境，用 react-dom/server 静态渲染。
// 直接渲染 `NodesCardList`：桩一个「窄屏」matchMedia 会顺着全局泄漏给同进程的其它用例，
// 把它们的宽表也换成卡片。版式切换本身只有一行（`useNarrowLayout()`），不值得为它冒这个险。

import { describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { NodesCardList } = await import('./nodes-card-list');
const { coalescePortReaches } = await import('./node-detail-ports');

const MEMBER_ID = 'aa'.repeat(16);
const PENDING_ID = 'cc'.repeat(16);

function row(overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    id: MEMBER_ID,
    runtimeNodeId: MEMBER_ID,
    name: 'laptop',
    publicKey: '',
    fingerprint: '',
    online: true,
    reach: 'lan',
    transport: 'dc',
    rttMs: 3,
    version: '2.4.1',
    directCapable: true,
    loggedIn: true,
    inventory: null,
    isSelf: false,
    isHub: false,
    hubMode: null,
    lastSeenAt: null,
    address: '192.168.1.20:9883',
    status: 'active',
    certificate: null,
    certSig: null,
    operation: null,
    admissionStatus: 'admitted',
    ...overrides,
  } as NodeRow;
}

const UPGRADE = {
  latest: { latestVersion: '2.4.2', changelog: null, publishedAt: null },
  entryOf: () => ({ phase: 'idle', targetVersion: null, error: null, cancelling: false }),
  start: () => undefined,
  startAll: () => undefined,
  cancel: () => undefined,
  batch: { running: false, total: 0, completed: 0 },
  eligibleCount: () => 0,
  anyRunning: false,
  restoring: false,
  restoringIds: new Set<string>(),
} as never;

function render(rows: NodeRow[], selected: Set<string> = new Set()): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NodesCardList
        rows={rows}
        hubApi={null}
        hubOnline
        hubWritable
        writerPublicUrl={null}
        hubDetails={new Map()}
        mode={{ uid: 'u1', kdfParams: {} } as never}
        api={{} as never}
        prompt={{} as never}
        onChanged={() => undefined}
        upgrade={UPGRADE}
        selection={{
          ids: selected,
          selectableCount: 1,
          toggle: () => undefined,
          toggleAll: () => undefined,
        }}
        uninstall={{ scheduledIds: new Set(), clearingIds: new Set() } as never}
        roleSwitch={
          {
            switchingIds: new Set(),
            stateOf: () => ({ intent: 'promote', blocked: null }),
          } as never
        }
      />
    </MemoryRouter>
  );
}

describe('窄屏节点记录卡', () => {
  test('不渲染表格，改渲染卡片，列表容器仍是 nodes-table', () => {
    const html = render([row()]);
    expect(html).not.toContain('<table');
    expect(html).toContain('data-testid="nodes-table"');
    expect(html).toContain(`data-testid="nodes-row-${MEMBER_ID}"`);
  });

  test('勾选、地址、升级、吊销与全选的 testid 与宽表一致', () => {
    const html = render([row()]);
    for (const testId of [
      `nodes-select-${MEMBER_ID}`,
      `nodes-status-${MEMBER_ID}`,
      `nodes-reach-${MEMBER_ID}`,
      `nodes-address-${MEMBER_ID}`,
      `node-upgrade-${MEMBER_ID}`,
      `node-more-${MEMBER_ID}`,
      `nodes-revoke-${MEMBER_ID}`,
      'nodes-select-all',
    ]) {
      expect(html).toContain(`data-testid="${testId}"`);
    }
    // 地址旁留一枚复制按钮：卡片里地址是截断显示的。
    expect(html).toContain(`data-testid="nodes-address-${MEMBER_ID}-copy"`);
  });

  // `mergeNodes` 拿不到地址时给的是字面量「—」（本机那一行的真实形状：peerAddress / endpoints
  // 全空），不是 null；卡片必须把这一档也当成「没有地址」。
  test.each([['—'], [''], [undefined]])('地址为 %p 时整行不出，也没有复制按钮', (address) => {
    const html = render([row({ address: address as string | undefined })]);
    expect(html).not.toContain(`data-testid="nodes-address-${MEMBER_ID}"`);
    expect(html).not.toContain(`data-testid="nodes-address-${MEMBER_ID}-copy"`);
  });

  test('连接方式 / 版本缺失时不摆破折号', () => {
    const html = render([row({ reach: null, transport: null, version: null })]);
    expect(html).not.toContain(`data-testid="nodes-reach-${MEMBER_ID}"`);
    expect(html).not.toContain('—');
  });

  test('直连能力写成一句话，不再是「支持直连 / 是」两列', () => {
    expect(render([row()])).toContain('nodes.table.mobile.direct');
    expect(render([row({ directCapable: false })])).toContain('nodes.table.mobile.noDirect');
  });

  test('勾选了节点时卡头写明已选台数', () => {
    expect(render([row()], new Set([MEMBER_ID]))).toContain('nodes.table.mobile.selected');
    expect(render([row()])).toContain('nodes.selection.selectAll');
  });

  test('待批准节点同样是一张卡，「批准加入」还在，地址「—」不占一行', () => {
    const html = render([
      row({ id: PENDING_ID, runtimeNodeId: PENDING_ID, pending: true, address: '—' }),
    ]);
    expect(html).not.toContain(`data-testid="nodes-address-${PENDING_ID}"`);
    expect(html).toContain(`data-testid="nodes-row-${PENDING_ID}"`);
    expect(html).toContain(`data-testid="nodes-admit-${PENDING_ID}"`);
    expect(html).toContain('data-admission="pending"');
  });

  test('空列表给一句空态', () => {
    expect(render([])).toContain('nodes.empty');
  });
});

describe('端口清单合并 TURN 两行', () => {
  test('控制口与紧邻的分配段合成一条，状态跟着控制口走', () => {
    const merged = coalescePortReaches([
      { purpose: 'turn-control', proto: 'udp', port: 40000, status: 'blocked' },
      { purpose: 'turn-relay', proto: 'udp', range: { begin: 40001, end: 40049 }, status: 'open' },
    ]);
    expect(merged).toEqual([
      {
        purpose: 'turn-control',
        proto: 'udp',
        range: { begin: 40000, end: 40049 },
        status: 'blocked',
      },
    ]);
  });

  test('不相邻时原样保留两条', () => {
    const rows = [
      { purpose: 'turn-control', proto: 'udp', port: 40000, status: 'open' },
      { purpose: 'turn-relay', proto: 'udp', range: { begin: 41000, end: 41049 }, status: 'open' },
    ] as const;
    expect(coalescePortReaches([...rows])).toHaveLength(2);
  });
});
