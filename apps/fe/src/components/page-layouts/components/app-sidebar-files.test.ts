import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const { filesSectionDefaultExpanded, hasMountedFilesRuntime } = await import('./app-sidebar');

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
    expect(hasMountedFilesRuntime(remote, {})).toBe(false);
    expect(hasMountedFilesRuntime(remote, { 'files:node-a': true })).toBe(true);
    expect(hasMountedFilesRuntime(remote, { 'files:node-a': false })).toBe(false);
  });

  test('没表过态的 self 在线已登录时挂运行时', () => {
    const self = {
      online: true,
      loggedIn: true,
      isSelf: true,
      runtimeNodeId: 'self',
    };
    expect(hasMountedFilesRuntime(self, {})).toBe(true);
    expect(hasMountedFilesRuntime(self, { 'files:self': false })).toBe(false);
  });

  test('离线或未登录一律不挂运行时', () => {
    expect(
      hasMountedFilesRuntime(
        { online: false, loggedIn: true, isSelf: true, runtimeNodeId: 'self' },
        {}
      )
    ).toBe(false);
    expect(
      hasMountedFilesRuntime(
        { online: true, loggedIn: false, isSelf: false, runtimeNodeId: 'node-a' },
        { 'files:node-a': true }
      )
    ).toBe(false);
  });
});
