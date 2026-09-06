// 「多节点通知」卡片：开关状态、汇聚节点状态行（含离线标记）、空态与转发队列提示。
// 无 DOM 测试环境，正文用 react-dom/server 静态渲染（与 nodes/management 各用例同一套做法）。

import { describe, expect, test } from 'bun:test';
import type { MeshNotificationSink, MeshNotificationState } from '@tmex/shared';
import enUS from '@tmex/shared/i18n/locales/en_US.json';
import zhCN from '@tmex/shared/i18n/locales/zh_CN.json';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MeshNotificationCardBody, meshQueueNote, meshSinkLabel, meshSinkSummary } = await import(
  './mesh-notification-card'
);

/** i18next 未初始化时 `useTranslation()` 的 t 就是回 key，这里保持同一约定。 */
const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

function sink(overrides: Partial<MeshNotificationSink> = {}): MeshNotificationSink {
  return { nodeId: 'aa'.repeat(16), name: 'studio', self: false, online: true, ...overrides };
}

function state(overrides: Partial<MeshNotificationState> = {}): MeshNotificationState {
  return { supported: true, selfEnabled: false, sinks: [], ...overrides };
}

function render(
  overrides: Partial<MeshNotificationState> = {},
  extra?: { error?: string }
): string {
  return renderToStaticMarkup(
    <MeshNotificationCardBody
      state={state(overrides)}
      saving={false}
      error={extra?.error ?? null}
      onEnabledChange={() => undefined}
    />
  );
}

describe('汇聚节点状态行', () => {
  test('没有汇聚节点：说明各节点只通知自身事件', () => {
    expect(meshSinkSummary([], t)).toBe('settings.notifications.mesh.empty');
    expect(zhCN.translation.settings.notifications.mesh.empty).toBe(
      '未启用汇聚，各节点仅通知自身事件。'
    );
    expect(enUS.translation.settings.notifications.mesh.empty).toBe(
      'No sink enabled. Each node only reports its own events.'
    );
  });

  test('多个汇聚节点：按分隔符逐个点名', () => {
    const summary = meshSinkSummary([sink({ name: 'studio' }), sink({ name: 'laptop' })], t);
    expect(summary).toContain('settings.notifications.mesh.sinks');
    expect(summary).toContain('studio');
    expect(summary).toContain('laptop');
  });

  test('离线的汇聚节点带尾注', () => {
    expect(meshSinkLabel(sink({ name: 'laptop', online: false }), t)).toBe(
      'settings.notifications.mesh.offlineName:{"name":"laptop"}'
    );
    expect(meshSinkLabel(sink({ name: 'laptop' }), t)).toBe('laptop');
  });
});

describe('转发队列提示', () => {
  test('没有积压也没有丢弃：不占一行', () => {
    expect(meshQueueNote(undefined, t)).toBeNull();
    expect(meshQueueNote({ pending: 0, dropped: 0 }, t)).toBeNull();
  });

  test('有积压就报数', () => {
    expect(meshQueueNote({ pending: 3, dropped: 1 }, t)).toBe(
      'settings.notifications.mesh.queue:{"pending":3,"dropped":1}'
    );
  });
});

describe('卡片正文', () => {
  test('未启用：开关不勾，状态行给空态', () => {
    const html = render({ selfEnabled: false });
    expect(html).toContain('data-testid="settings-mesh-notify-switch"');
    expect(html).toContain('data-testid="settings-mesh-notify-sinks"');
    expect(html).toContain('settings.notifications.mesh.empty');
    expect(html).toContain('aria-checked="false"');
  });

  test('已启用且有汇聚节点：开关勾上，状态行点名', () => {
    const html = render({
      selfEnabled: true,
      sinks: [sink({ name: 'studio', self: true }), sink({ name: 'laptop', online: false })],
    });
    // i18next 未初始化时 t 只回 key，这里断言渲染的是「有汇聚节点」那一条而不是空态。
    expect(html).toContain('settings.notifications.mesh.sinks');
    expect(html).not.toContain('settings.notifications.mesh.empty');
    expect(html).toContain('aria-checked="true"');
  });

  test('转发队列有积压：多一行提示', () => {
    const html = render({ selfEnabled: true, forwardQueue: { pending: 2, dropped: 5 } });
    expect(html).toContain('data-testid="settings-mesh-notify-queue"');
  });

  test('保存失败：正文里挂一条错误提示', () => {
    const html = render({ selfEnabled: true }, { error: 'boom' });
    expect(html).toContain('data-testid="settings-mesh-notify-error"');
    expect(html).toContain('boom');
  });
});
