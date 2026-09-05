import { describe, expect, mock, test } from 'bun:test';

// resolveRuntimeCore 只做选项归一，不碰 WS / localStorage / window，本文件无需相应垫片。
// 唯一保留的前奏：runtime.ts 在模块求值时把 playBellSound 固化进 defaultBell，
// 必须先于 ./runtime 首次求值替换掉，否则后续文件的 bell 用例会真的去建 AudioContext。
const notificationsActual = await import('@tmex/notifications');
mock.module('@tmex/notifications', () => ({
  ...notificationsActual,
  playBellSound: mock(() => {}),
}));

const { resolveRuntimeCore } = await import('./runtime');

describe('runtime features resolution', () => {
  test('defaults keep every UI switch on (open-source host unchanged)', () => {
    const core = resolveRuntimeCore();
    expect(core.features).toEqual({
      agentUi: true,
      watchUi: true,
      filesUi: true,
      hostManagedNotifications: false,
      shareViewer: false,
    });
  });

  test('empty features object still resolves to defaults', () => {
    const core = resolveRuntimeCore({ features: {} });
    expect(core.features.agentUi).toBe(true);
    expect(core.features.watchUi).toBe(true);
    expect(core.features.filesUi).toBe(true);
  });

  test('watchUi can be switched off independently of agentUi', () => {
    const core = resolveRuntimeCore({ features: { watchUi: false } });
    expect(core.features.watchUi).toBe(false);
    expect(core.features.agentUi).toBe(true);
    expect(core.features.hostManagedNotifications).toBe(false);
  });

  test('agentUi off does not affect watchUi default', () => {
    const core = resolveRuntimeCore({ features: { agentUi: false } });
    expect(core.features.agentUi).toBe(false);
    expect(core.features.watchUi).toBe(true);
  });

  test('filesUi can be switched off independently', () => {
    const core = resolveRuntimeCore({ features: { filesUi: false } });
    expect(core.features.filesUi).toBe(false);
    expect(core.features.agentUi).toBe(true);
    expect(core.features.watchUi).toBe(true);
  });

  test('shareViewer defaults to false and can be switched on alone', () => {
    expect(resolveRuntimeCore().features.shareViewer).toBe(false);
    const core = resolveRuntimeCore({ features: { shareViewer: true } });
    expect(core.features.shareViewer).toBe(true);
    expect(core.features.agentUi).toBe(true);
    expect(core.features.filesUi).toBe(true);
  });
});
