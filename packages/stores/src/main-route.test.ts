import { beforeEach, describe, expect, test } from 'bun:test';

import {
  MAIN_ROUTE_FALLBACK,
  getLastMainRoute,
  isFileViewPath,
  rememberMainRoute,
  resetMainRouteForTest,
  shouldShowExplorerOnTabChange,
} from './main-route';

describe('文件视图路径', () => {
  test('文件管理器与文件预览（含 node 前缀）都算文件视图', () => {
    expect(isFileViewPath('/explorer')).toBe(true);
    expect(isFileViewPath('/file/abc')).toBe(true);
    expect(isFileViewPath('/n/node-1/file/abc')).toBe(true);
  });

  test('终端、设备管理等其它页面不是文件视图', () => {
    expect(isFileViewPath('/')).toBe(false);
    expect(isFileViewPath('/devices/d1/windows/@1/panes/%252')).toBe(false);
    expect(isFileViewPath('/n/node-1/devices/d1/windows/@1/panes/%252')).toBe(false);
    expect(isFileViewPath('/settings')).toBe(false);
    expect(isFileViewPath('/explorer2')).toBe(false);
    expect(isFileViewPath('/files')).toBe(false);
  });
});

describe('切 tab 是否带去文件管理器', () => {
  test('切到文件 tab 且主区不在文件视图时才跳转', () => {
    expect(shouldShowExplorerOnTabChange('files', '/devices/d1/windows/@1/panes/%252')).toBe(true);
    expect(shouldShowExplorerOnTabChange('files', '/')).toBe(true);
    expect(shouldShowExplorerOnTabChange('files', '/explorer')).toBe(false);
    expect(shouldShowExplorerOnTabChange('files', '/file/abc')).toBe(false);
    expect(shouldShowExplorerOnTabChange('files', '/n/node-1/file/abc')).toBe(false);
  });

  test('切到其它 tab 永不跳转', () => {
    expect(shouldShowExplorerOnTabChange('panes', '/devices/d1')).toBe(false);
    expect(shouldShowExplorerOnTabChange('agent', '/explorer')).toBe(false);
  });
});

describe('主区路由记忆', () => {
  beforeEach(resetMainRouteForTest);

  test('未记录时回退到根路径', () => {
    expect(getLastMainRoute()).toBe(MAIN_ROUTE_FALLBACK);
  });

  test('记住最近一次非文件视图路由，文件视图不覆盖', () => {
    rememberMainRoute({ pathname: '/devices/d1/windows/@1/panes/%252' });
    rememberMainRoute({ pathname: '/explorer' });
    rememberMainRoute({ pathname: '/file/abc', search: '?x=1' });
    expect(getLastMainRoute()).toBe('/devices/d1/windows/@1/panes/%252');
    rememberMainRoute({ pathname: '/settings' });
    expect(getLastMainRoute()).toBe('/settings');
  });

  test('search 与 hash 一并记住，回去时不丢 ?tab= / ?panel=', () => {
    rememberMainRoute({ pathname: '/settings', search: '?tab=files', hash: '#a' });
    expect(getLastMainRoute()).toBe('/settings?tab=files#a');
    rememberMainRoute({ pathname: '/explorer', search: '?panel=connect' });
    expect(getLastMainRoute()).toBe('/settings?tab=files#a');
  });
});
