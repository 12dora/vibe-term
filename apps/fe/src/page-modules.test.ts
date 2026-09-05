// 首帧后的空闲预热只覆盖侧栏两个顶层入口：终端页与文件页的重依赖不能提前抢带宽。

import { describe, expect, test } from 'bun:test';
import { IDLE_PRELOAD_PAGE_MODULES, devicesPageModule, settingsPageModule } from './page-modules';

describe('IDLE_PRELOAD_PAGE_MODULES', () => {
  test('只预热设备页与设置页', () => {
    expect(IDLE_PRELOAD_PAGE_MODULES).toEqual([devicesPageModule, settingsPageModule]);
  });

  test('不含终端页 / 文件页 / 登录页（DevicePage 拖 WASM，FilePage 拖 highlight.js）', () => {
    const sources = IDLE_PRELOAD_PAGE_MODULES.map((loader) => loader.toString()).join('\n');
    expect(sources).toContain('DevicesPage');
    expect(sources).toContain('SettingsPage');
    expect(sources).not.toContain('DevicePage');
    expect(sources).not.toContain('FilePage');
    expect(sources).not.toContain('LoginPage');
  });
});
