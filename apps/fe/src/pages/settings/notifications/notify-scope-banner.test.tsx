// 「通知」标签顶部的范围提示：路由 node 决定提示哪一条，standalone 不提示。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 node-runtime-boundary 用例同一套做法）。

import { afterEach, describe, expect, test } from 'bun:test';
import type { AuthModeResponse } from '@vibeterm/api-client/auth/index';
import enUS from '@vibeterm/shared/i18n/locales/en_US.json';
import zhCN from '@vibeterm/shared/i18n/locales/zh_CN.json';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const { NotifyScopeBanner, nodeDisplayName } = await import('./notify-scope-banner');
const { resetMeshNodesStateForTest, setMeshNodesStateForTest } = await import('@/node/mesh-nodes');

const NODE_B = 'bb'.repeat(16);
const ENTRY = 'aa'.repeat(16);

function meshMode(mode: 'mesh' | 'none'): AuthModeResponse {
  return { mode } as AuthModeResponse;
}

function setMesh(enabled: boolean): void {
  setMeshNodesStateForTest({
    mode: meshMode(enabled ? 'mesh' : 'none'),
    modeLoaded: true,
    entryNodeId: ENTRY,
    nodes: [
      { id: ENTRY, name: 'hub', online: true },
      { id: NODE_B, name: 'laptop', online: true },
    ] as never,
  });
}

function render(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <NotifyScopeBanner />
    </MemoryRouter>
  );
}

afterEach(() => {
  resetMeshNodesStateForTest();
});

describe('节点名兜底', () => {
  test('节点目录还没拉到：退回编号前缀', () => {
    expect(nodeDisplayName(NODE_B, null)).toBe(NODE_B.slice(0, 8));
    expect(nodeDisplayName(NODE_B, 'laptop')).toBe('laptop');
  });
});

describe('范围提示', () => {
  test('standalone：不提示', () => {
    setMesh(false);
    expect(render('/settings')).toBe('');
  });

  test('本机 + 已互联：提示通道只属于本机', () => {
    setMesh(true);
    const html = render('/settings');
    expect(html).toContain('data-testid="settings-notify-scope-banner"');
    expect(html).toContain('settings.notifications.scope.self');
  });

  test('`/n/<entry 自身 id>` 是本机的别名：按本机提示，不当远端', () => {
    setMesh(true);
    const html = render(`/n/${ENTRY}/settings`);
    expect(html).toContain('settings.notifications.scope.self');
    expect(html).not.toContain('settings.notifications.scope.remote');
  });

  test('远端节点：提示正在编辑的是哪一台', () => {
    setMesh(true);
    const html = render(`/n/${NODE_B}/settings`);
    expect(html).toContain('data-testid="settings-notify-scope-banner"');
    expect(html).toContain('settings.notifications.scope.remote');
  });

  test('standalone 但走 `/n/<id>` 路由：仍要提示编辑的是远端节点', () => {
    setMesh(false);
    expect(render(`/n/${NODE_B}/settings`)).toContain('settings.notifications.scope.remote');
  });
});

describe('文案', () => {
  test('三语同步', () => {
    expect(zhCN.translation.settings.notifications.scope.remote).toBe(
      '当前编辑的是「{{name}}」的通知通道。'
    );
    expect(enUS.translation.settings.notifications.scope.remote).toBe(
      'Editing notification channels of "{{name}}".'
    );
  });
});
