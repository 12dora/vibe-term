// 待同步行：显示「同步中」，没有批准按钮，其余动作一律禁用。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 nodes-management 测试同一套做法）。

import { describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { NodesTable } = await import('./nodes-table');
const { selectableRows } = await import('./bulk-actions-menu');

const PENDING_ID = 'cc'.repeat(16);
const MEMBER_ID = 'aa'.repeat(16);

function pendingRow(overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    id: PENDING_ID,
    runtimeNodeId: PENDING_ID,
    name: 'laptop',
    publicKey: '',
    fingerprint: '',
    online: false,
    reach: null,
    transport: null,
    rttMs: null,
    version: null,
    directCapable: false,
    loggedIn: false,
    inventory: null,
    isSelf: false,
    lastSeenAt: null,
    status: 'enrolled',
    certificate: 'cert',
    certSig: 'cert-sig',
    operation: null,
    pending: true,
    ...overrides,
  };
}

const UPGRADE = {
  latest: null,
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

function render(row: NodeRow, options: { writable?: boolean } = {}): string {
  const writable = options.writable !== false;
  return renderToStaticMarkup(
    <MemoryRouter>
      <NodesTable
        rows={[row]}
        uplinkWritable={writable}
        blockedHint="relay.tenant.notAttached"
        mode={{ uid: 'u1', kdfParams: {} } as never}
        api={{} as never}
        prompt={{} as never}
        onChanged={() => undefined}
        upgrade={UPGRADE}
        selection={{
          ids: new Set(),
          selectableCount: 0,
          toggle: () => undefined,
          toggleAll: () => undefined,
        }}
        uninstall={{ scheduledIds: new Set(), clearingIds: new Set() } as never}
      />
    </MemoryRouter>
  );
}

/** `data-testid="x"` 所在那个标签的完整开标签文本。 */
function tagOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

describe('待同步行', () => {
  test('状态列显示「同步中」，没有批准按钮', () => {
    const html = render(pendingRow());
    expect(html).toContain('nodes.status.pending');
    expect(tagOf(html, `nodes-status-${PENDING_ID}`)).toContain('data-admission="pending"');
    expect(html).not.toContain('nodes.actions.admit');
    expect(html).not.toContain(`nodes-admit-${PENDING_ID}`);
    expect(html).not.toContain('nodes.admit.unavailable');
  });

  test('升级 / 详情 / 移除都不可用：升级按钮根本不出现，其余两个禁用', () => {
    const html = render(pendingRow());
    expect(html).not.toContain(`node-upgrade-${PENDING_ID}`);
    expect(html).not.toContain(`nodes-detail-${PENDING_ID}`);
    expect(html).not.toContain(`nodes-revoke-${PENDING_ID}`);
    expect(tagOf(html, `node-more-${PENDING_ID}`)).toContain('disabled=""');
    expect(html).toContain('nodes.actions.more');
    expect(html).toContain('nodes.actions.revoke');
    expect(html).toContain('disabled=""');
  });

  test('上联不收写入时禁用按钮说明原因', () => {
    const html = render(pendingRow(), { writable: false });
    expect(tagOf(html, `node-more-${PENDING_ID}`)).toContain('disabled=""');
    expect(html).toContain('relay.tenant.notAttached');
  });

  test('名字为空时不至于渲染出空标题', () => {
    const html = render(pendingRow({ name: PENDING_ID.slice(0, 8) }));
    expect(html).toContain(PENDING_ID.slice(0, 8));
  });

  test('待同步行不可勾选：批量升级 / 移除都碰不到它', () => {
    const rows = [pendingRow(), pendingRow({ id: MEMBER_ID, pending: false })];
    expect(selectableRows(rows, new Set()).map((row) => row.id)).toEqual([MEMBER_ID]);
  });

  test('REACH 与地址都是破折号，没有指纹列与登录状态列', () => {
    const html = render(pendingRow());
    expect(html).toContain(`data-testid="nodes-reach-${PENDING_ID}"`);
    expect(html).toContain(`data-testid="nodes-address-${PENDING_ID}"`);
    expect(html).toContain('nodes.columns.address');
    expect(html).not.toContain('nodes.columns.lastSeen');
    expect(html).not.toContain('nodes.columns.fingerprint');
    expect(html).not.toContain('nodes.columns.login');
    expect((html.match(/<th\b/g) ?? []).length).toBe(8);
    expect((html.match(/<td\b/g) ?? []).length).toBe(8);
  });
});
