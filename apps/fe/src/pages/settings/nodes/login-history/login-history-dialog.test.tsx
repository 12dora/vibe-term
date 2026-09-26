// 登录历史的静态渲染：页签、后台开关、保留时间与清空、跳过标签、两种版式的列。
// 用无资源的独立 i18next 实例注入：缺 key 原样返回（有 defaultValue 时返回它），断言的是 key 与 testId；
// 同进程其他测试会初始化全局实例，独立实例让结果与文件顺序无关。

import { describe, expect, test } from 'bun:test';
import type { LoginRecord } from '@vibeterm/shared';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { LoginHistoryRow } from './login-history-data';
import type { LoginHistoryNode } from './login-history-nodes';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en_US',
  resources: {},
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function render(node: ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}
const { LoginHistoryToolbar, SkippedNodeChips, batchSummaryText, mergeSkips, retentionLabel } =
  await import('./login-history-dialog');
const { LoginHistoryCards, LoginHistoryWideTable } = await import('./login-history-table');
const { methodText, reasonText } = await import('./login-history-format');

const NOW = 1_700_000_000_000;
const SELF: LoginHistoryNode = { id: 'self', meshId: 'a'.repeat(32), name: '本机', isSelf: true };
const B: LoginHistoryNode = {
  id: 'b'.repeat(32),
  meshId: 'b'.repeat(32),
  name: 'beta',
  isSelf: false,
};

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}${JSON.stringify(options)}` : key;

function row(patch: Partial<LoginRecord> = {}, node: LoginHistoryNode = SELF): LoginHistoryRow {
  const record = {
    id: 'r1',
    at: NOW - 120_000,
    outcome: 'success',
    uid: 'u1',
    username: 'alice',
    method: 'root',
    second: 'totp',
    client: 'web',
    kind: 'interactive',
    viaNodeId: null,
    targetNodeId: null,
    ip: '203.0.113.7',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    origin: 'https://vt.example.com',
    code: null,
    ...patch,
  } as LoginRecord;
  return { ...record, node, rowKey: `${node.id}:${record.id}` };
}

const toolbarProps = {
  onOutcomeChange: () => undefined,
  includeBackground: false,
  onIncludeBackgroundChange: () => undefined,
  retention: 90,
  retentionBusy: false,
  onRetentionChange: () => undefined,
  clearBusy: false,
  onClear: () => undefined,
};

describe('LoginHistoryToolbar', () => {
  test('success tab shows the background toggle, retention and clear', () => {
    const html = render(<LoginHistoryToolbar outcome="success" {...toolbarProps} />);
    expect(html).toContain('data-testid="login-history-tab-success"');
    expect(html).toContain('data-testid="login-history-tab-failed"');
    expect(html).toContain('data-testid="login-history-background"');
    expect(html).toContain('settings.loginHistory.showBackground');
    expect(html).toContain('data-testid="login-history-retention"');
    expect(html).toContain('settings.loginHistory.retention.days');
    expect(html).toContain('data-testid="login-history-clear"');
  });

  test('failed tab hides the background toggle; mixed retention shows its own label', () => {
    const html = render(
      <LoginHistoryToolbar outcome="failed" {...toolbarProps} retention={null} />
    );
    expect(html).not.toContain('login-history-background');
    expect(html).toContain('settings.loginHistory.retention.mixed');
  });
});

describe('retentionLabel', () => {
  test('0 is forever', () => {
    expect(retentionLabel(t, 0)).toBe('settings.loginHistory.retention.forever');
    expect(retentionLabel(t, 30)).toBe('settings.loginHistory.retention.days{"n":30}');
  });
});

describe('SkippedNodeChips', () => {
  test('one chip per node with its reason', () => {
    const html = render(
      <SkippedNodeChips
        skipped={[
          { node: B, reason: 'tooOld' },
          { node: { ...B, id: 'c'.repeat(32), name: 'gamma' }, reason: 'offline' },
        ]}
      />
    );
    expect(html).toContain(`data-testid="login-history-skipped-${B.id}"`);
    expect(html).toContain('data-reason="tooOld"');
    expect(html).toContain('settings.loginHistory.skip.offline');
  });

  test('renders nothing when no node is skipped', () => {
    expect(render(<SkippedNodeChips skipped={[]} />)).toBe('');
  });
});

describe('batchSummaryText', () => {
  test('all done → success; skipped nodes turn it into a warning with names', () => {
    const done = { done: [SELF, B], failed: [], deleted: 12 };
    expect(batchSummaryText(t, 'x.done', done, []).level).toBe('success');
    const partial = batchSummaryText(t, 'x.done', { ...done, done: [SELF] }, [
      { node: B, reason: 'offline' },
    ]);
    expect(partial.level).toBe('warning');
    expect(partial.text).toContain('settings.loginHistory.partial');
    expect(partial.text).toContain('beta');
  });

  test('mergeSkips keeps the first reason per node', () => {
    expect(
      mergeSkips([{ node: B, reason: 'tooOld' }], [{ node: B, reason: 'failed' }]).map(
        (item) => item.reason
      )
    ).toEqual(['tooOld']);
  });
});

describe('LoginHistoryWideTable', () => {
  const names = new Map([[SELF.meshId, '本机']]);

  test('success rows: node, method, client, IP, parsed device', () => {
    const html = render(
      <LoginHistoryWideTable
        rows={[row()]}
        outcome="success"
        now={NOW}
        nodeNames={names}
        emptyText="empty"
      />
    );
    expect(html).toContain('data-testid="login-history-row-self:r1"');
    expect(html).toContain('settings.loginHistory.method.passwordTotp');
    expect(html).toContain('settings.loginHistory.client.web');
    expect(html).toContain('203.0.113.7');
    expect(html).toContain('Chrome · macOS');
    expect(html).not.toContain('settings.loginHistory.columns.reason');
  });

  test('background rows name the entry node', () => {
    const html = render(
      <LoginHistoryWideTable
        rows={[row({ kind: 'background', viaNodeId: SELF.meshId }, B)]}
        outcome="success"
        now={NOW}
        nodeNames={names}
        emptyText="empty"
      />
    );
    expect(html).toContain(`data-testid="login-history-entry-${B.id}:r1"`);
    expect(html).toContain('settings.loginHistory.viaEntry');
  });

  test('failed rows show account and reason', () => {
    const html = render(
      <LoginHistoryWideTable
        rows={[row({ outcome: 'failed', code: 'TOTP_INVALID', username: 'mallory' })]}
        outcome="failed"
        now={NOW}
        nodeNames={names}
        emptyText="empty"
      />
    );
    expect(html).toContain('settings.loginHistory.columns.reason');
    expect(html).toContain('mallory');
    expect(html).toContain('data-testid="login-history-reason-self:r1"');
    // 专用文案与通用错误表都缺时一路落到原码。
    expect(html).toContain('>TOTP_INVALID</td>');
  });

  test('empty state', () => {
    const html = render(
      <LoginHistoryWideTable
        rows={[]}
        outcome="failed"
        now={NOW}
        nodeNames={names}
        emptyText="nothing here"
      />
    );
    expect(html).toContain('data-testid="login-history-empty"');
    expect(html).toContain('nothing here');
  });
});

describe('LoginHistoryCards', () => {
  test('narrow layout keeps the same test ids', () => {
    const html = render(
      <LoginHistoryCards
        rows={[row({ outcome: 'failed', code: 'RATE_LIMITED' })]}
        outcome="failed"
        now={NOW}
        nodeNames={new Map()}
        emptyText="empty"
      />
    );
    expect(html).toContain('data-testid="login-history-table"');
    expect(html).toContain('data-testid="login-history-row-self:r1"');
    expect(html).toContain('data-testid="login-history-reason-self:r1"');
  });
});

describe('format', () => {
  test('methodText covers every combination', () => {
    expect(methodText(t, { method: 'passkey', second: 'none' })).toBe(
      'settings.loginHistory.method.passkey'
    );
    expect(methodText(t, { method: 'root', second: 'waived' })).toBe(
      'settings.loginHistory.method.passwordWaived'
    );
    expect(methodText(t, { method: 'root', second: 'passkey' })).toBe(
      'settings.loginHistory.method.passwordPasskey'
    );
    expect(methodText(t, { method: 'root', second: null })).toBe(
      'settings.loginHistory.method.password'
    );
    expect(methodText(t, { method: null, second: null })).toBe('—');
  });

  test('reasonText falls back to the generic error table, then the raw code', () => {
    const lookup = (key: string, options?: Record<string, unknown>) =>
      key === 'settings.loginHistory.reason.unknown'
        ? 'unknown'
        : String(options?.defaultValue ?? key);
    expect(reasonText(lookup, null)).toBe('unknown');
    expect(reasonText(lookup, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
