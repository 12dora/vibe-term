// 底部导航的高亮匹配：只认「就是这一页」，终端深链不该点亮「管理设备」。

import { describe, expect, test } from 'bun:test';
import { isPathActive, normalizeNavPath } from './nav-main';

describe('normalizeNavPath', () => {
  test('剥掉 /n/:nodeId 前缀、query/hash 与结尾斜杠', () => {
    expect(normalizeNavPath('/n/node1/devices')).toBe('/devices');
    expect(normalizeNavPath('/n/node1')).toBe('/');
    expect(normalizeNavPath('/devices/')).toBe('/devices');
    expect(normalizeNavPath('/settings?tab=devicesAndFiles')).toBe('/settings');
    expect(normalizeNavPath('/settings#anchor')).toBe('/settings');
    expect(normalizeNavPath('/')).toBe('/');
  });

  test('不吃掉恰好叫 n 的普通路径段', () => {
    expect(normalizeNavPath('/n')).toBe('/n');
    expect(normalizeNavPath('/devices/n/node1')).toBe('/devices/n/node1');
  });
});

describe('isPathActive', () => {
  test('「管理设备」只在 /devices 本身点亮', () => {
    expect(isPathActive('/devices', '/devices')).toBe(true);
    expect(isPathActive('/devices/abc', '/devices')).toBe(false);
    expect(isPathActive('/devices/abc/windows/w/panes/p', '/devices')).toBe(false);
  });

  test('带 node 前缀的地址与未加前缀的导航项归一后仍能对上', () => {
    expect(isPathActive('/n/node1/devices', '/devices')).toBe(true);
    expect(isPathActive('/n/node1/devices/abc', '/devices')).toBe(false);
    expect(isPathActive('/devices', '/n/node1/devices')).toBe(true);
  });

  test('设置页不会被无关路由点亮，带 query 的设置页仍点亮', () => {
    expect(isPathActive('/settings?tab=devicesAndFiles', '/settings')).toBe(true);
    expect(isPathActive('/settings?tab=devicesAndFiles', '/devices')).toBe(false);
    expect(isPathActive('/devices', '/settings')).toBe(false);
  });
});
