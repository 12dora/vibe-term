import { describe, expect, test } from 'bun:test';
import {
  createShareAppPath,
  isSharePathname,
  parsePaneAppPath,
  shareConsoleQuery,
  sharePagePath,
} from './share-route';

const NODE = 'a'.repeat(32);

describe('sharePagePath', () => {
  test('self 无前缀', () => {
    expect(sharePagePath('self', 'abc')).toBe('/s/abc');
    expect(sharePagePath(undefined, 'abc')).toBe('/s/abc');
  });

  test('远端 node 带 /n/<id> 前缀，shareId 经 URL 编码', () => {
    expect(sharePagePath(NODE, 'a b')).toBe(`/n/${NODE}/s/a%20b`);
  });
});

describe('isSharePathname', () => {
  test('两种分享路由都认', () => {
    expect(isSharePathname('/s/abc')).toBe(true);
    expect(isSharePathname('/s/abc/')).toBe(true);
    expect(isSharePathname(`/n/${NODE}/s/abc`)).toBe(true);
  });

  test('其余路径一概不认（node id 必须规范）', () => {
    expect(isSharePathname('/')).toBe(false);
    expect(isSharePathname('/login')).toBe(false);
    expect(isSharePathname('/settings')).toBe(false);
    expect(isSharePathname('/s/abc/extra')).toBe(false);
    expect(isSharePathname('/n/short/s/abc')).toBe(false);
    expect(isSharePathname('/devices/d1')).toBe(false);
  });
});

describe('parsePaneAppPath', () => {
  test('取出 window / pane 并解码', () => {
    expect(parsePaneAppPath('/devices/d1/windows/@3/panes/%251')).toEqual({
      windowId: '@3',
      paneId: '%1',
    });
  });

  test('非 pane 路径返回 null', () => {
    expect(parsePaneAppPath('/devices')).toBeNull();
    expect(parsePaneAppPath('/devices/d1')).toBeNull();
    expect(parsePaneAppPath('/file/abc')).toBeNull();
  });
});

describe('shareConsoleQuery', () => {
  test('两项都在时拼成 ?w=&p=', () => {
    expect(shareConsoleQuery({ windowId: '@3', paneId: '%1' })).toBe('?w=%403&p=%251');
  });

  test('都缺时为空串', () => {
    expect(shareConsoleQuery({})).toBe('');
  });
});

describe('createShareAppPath', () => {
  const appPath = createShareAppPath('/s/abc');

  test('pane 路径映射成本页查询串', () => {
    expect(appPath('/devices/d1/windows/@3/panes/%251')).toBe('/s/abc?w=%403&p=%251');
  });

  test('其余路径一律回到分享页本身（访客不会被带走）', () => {
    expect(appPath('/devices')).toBe('/s/abc');
    expect(appPath('/file/xyz')).toBe('/s/abc');
    expect(appPath('/settings')).toBe('/s/abc');
  });
});
