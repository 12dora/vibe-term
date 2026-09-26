import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const { filesSectionDefaultExpanded, hasMountedFilesRuntime } = await import('./app-sidebar');

const OPT_IN = { 'node-a:d1': true };

describe('文件侧栏远端缺省折叠', () => {
  test('self 缺省展开，远端缺省折叠', () => {
    expect(filesSectionDefaultExpanded(true)).toBe(true);
    expect(filesSectionDefaultExpanded(false)).toBe(false);
  });

  test('没表过态的远端即使在线已登录也不挂运行时', () => {
    const remote = {
      online: true,
      loggedIn: true,
      isSelf: false,
      runtimeNodeId: 'node-a',
    };
    expect(hasMountedFilesRuntime(remote, {}, OPT_IN)).toBe(false);
    expect(hasMountedFilesRuntime(remote, { 'files:node-a': true }, OPT_IN)).toBe(true);
    expect(hasMountedFilesRuntime(remote, { 'files:node-a': false }, OPT_IN)).toBe(false);
  });

  test('没表过态的 self 在线已登录时挂运行时', () => {
    const self = {
      online: true,
      loggedIn: true,
      isSelf: true,
      runtimeNodeId: 'self',
    };
    expect(hasMountedFilesRuntime(self, {}, OPT_IN)).toBe(true);
  });

  test('self 折叠也挂运行时：要靠目录列表判断出不出分节头，否则点开才消失', () => {
    const self = {
      online: true,
      loggedIn: true,
      isSelf: true,
      runtimeNodeId: 'self',
    };
    expect(hasMountedFilesRuntime(self, { 'files:self': false }, OPT_IN)).toBe(true);
  });

  test('远端展开态为真、但没有设备打开「文件」时也不挂运行时（展开必为空）', () => {
    const remote = {
      online: true,
      loggedIn: true,
      isSelf: false,
      runtimeNodeId: 'node-a',
    };
    const expanded = { 'files:node-a': true };
    expect(hasMountedFilesRuntime(remote, expanded, {})).toBe(false);
    expect(hasMountedFilesRuntime(remote, expanded, { 'node-a:d1': false })).toBe(false);
    expect(hasMountedFilesRuntime(remote, expanded, { 'node-b:d1': true })).toBe(false);
    expect(hasMountedFilesRuntime(remote, expanded, OPT_IN)).toBe(true);
  });

  test('self 与文件开关无关：推断不出，一律挂运行时交给目录列表', () => {
    const self = { online: true, loggedIn: true, isSelf: true, runtimeNodeId: 'self' };
    expect(hasMountedFilesRuntime(self, {}, { 'self:d1': false })).toBe(true);
  });

  test('离线或未登录一律不挂运行时', () => {
    expect(
      hasMountedFilesRuntime(
        { online: false, loggedIn: true, isSelf: true, runtimeNodeId: 'self' },
        {},
        OPT_IN
      )
    ).toBe(false);
    expect(
      hasMountedFilesRuntime(
        { online: true, loggedIn: false, isSelf: false, runtimeNodeId: 'node-a' },
        { 'files:node-a': true },
        OPT_IN
      )
    ).toBe(false);
  });
});
