// 待批准行：显示「待批准」与「批准加入」，其余动作一律禁用。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 nodes-management 测试同一套做法）。

import { describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
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
    isHub: false,
    hubMode: null,
    lastSeenAt: null,
    status: 'enrolled',
    certificate: 'cert',
    certSig: 'cert-sig',
    operation: null,
    admissionStatus: 'pending',
    pending: true,
    admitMaterial: {
      enrollmentId: 'enr-1',
      authorization: 'auth',
      authorizationSig: 'auth-sig',
      certificate: 'cert',
      certSig: 'cert-sig',
    },
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
    <NodesTable
      rows={[row]}
      hubApi={null}
      hubOnline={writable}
      hubWritable={writable}
      writerPublicUrl={null}
      hubDetails={new Map()}
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
      roleSwitch={
        { switchingIds: new Set(), stateOf: () => ({ intent: 'promote', blocked: null }) } as never
      }
    />
  );
}

/** `data-testid="x"` 所在那个标签的完整开标签文本。 */
function tagOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

describe('待批准行', () => {
  test('状态列显示「待批准」，并给出批准按钮', () => {
    const html = render(pendingRow());
    expect(html).toContain('nodes.status.pending');
    expect(tagOf(html, `nodes-status-${PENDING_ID}`)).toContain('data-admission="pending"');
    expect(html).toContain('nodes.actions.admit');
    expect(tagOf(html, `nodes-admit-${PENDING_ID}`)).not.toContain('disabled=""');
  });

  test('升级 / 详情 / 移除都不可用：升级按钮根本不出现，其余两个禁用', () => {
    const html = render(pendingRow());
    expect(html).not.toContain(`node-upgrade-${PENDING_ID}`);
    expect(html).not.toContain(`nodes-detail-${PENDING_ID}`);
    expect(html).not.toContain(`nodes-revoke-${PENDING_ID}`);
    // 「更多」「移除」仍在，但都是禁用态。
    expect(html).toContain('nodes.actions.more');
    expect(html).toContain('nodes.actions.revoke');
    expect(html).toContain('nodes.admit.blocked');
    expect(html).toContain('disabled=""');
  });

  test('Hub 不收写入时批准按钮禁用并说明原因', () => {
    const html = render(pendingRow(), { writable: false });
    expect(tagOf(html, `nodes-admit-${PENDING_ID}`)).toContain('disabled=""');
    expect(html).toContain('nodes.hubs.standbyNotice');
  });

  test('Hub 没下发材料时批准按钮禁用', () => {
    const html = render(pendingRow({ admitMaterial: null }));
    expect(tagOf(html, `nodes-admit-${PENDING_ID}`)).toContain('disabled=""');
    expect(html).toContain('nodes.admit.unavailable');
  });

  test('禁用原因渲染成可见说明，并用 aria-describedby 关联到按钮', () => {
    const html = render(pendingRow({ admitMaterial: null }));
    const hint = tagOf(html, 'pending-node-admit-hint');
    expect(hint).toContain(`id="nodes-admit-hint-${PENDING_ID}"`);
    expect(tagOf(html, `nodes-admit-${PENDING_ID}`)).toContain(
      `aria-describedby="nodes-admit-hint-${PENDING_ID}"`
    );
    // 说明文字本身可见（不是只挂在 title 上）。
    expect(html.slice(html.indexOf(hint))).toContain('nodes.admit.unavailable</span>');
  });

  test('可以批准时不渲染多余的说明，也不留下空的 aria-describedby', () => {
    const html = render(pendingRow());
    expect(html).not.toContain('pending-node-admit-hint');
    expect(tagOf(html, `nodes-admit-${PENDING_ID}`)).not.toContain('aria-describedby');
  });

  test('名字为空时不至于渲染出空标题', () => {
    const html = render(pendingRow({ name: PENDING_ID.slice(0, 8) }));
    expect(html).toContain(PENDING_ID.slice(0, 8));
  });

  test('待批准行不可勾选：批量升级 / 移除都碰不到它', () => {
    const rows = [pendingRow(), pendingRow({ id: MEMBER_ID, pending: false })];
    expect(selectableRows(rows, new Set()).map((row) => row.id)).toEqual([MEMBER_ID]);
  });
});
