// 首帧后的空闲预热只覆盖侧栏两个顶层入口：终端页与文件页的重依赖不能提前抢带宽。

import { describe, expect, test } from 'bun:test';
import {
  IDLE_PRELOAD_PAGE_MODULES,
  devicesPageModule,
  settingsPageModule,
  sharePageModule,
} from './page-modules';

describe('sharePageModule', () => {
  test('被分享页单独成 chunk（入口不静态引它）', () => {
    expect(sharePageModule.toString()).toContain('SharePage');
  });
});

describe('IDLE_PRELOAD_PAGE_MODULES', () => {
  test('只预热设备页与设置页', () => {
    expect(IDLE_PRELOAD_PAGE_MODULES).toEqual([devicesPageModule, settingsPageModule]);
  });

  test('不含终端页 / 文件页 / 登录页 / 分享页（DevicePage 拖 WASM，FilePage 拖 highlight.js）', () => {
    const sources = IDLE_PRELOAD_PAGE_MODULES.map((loader) => loader.toString()).join('\n');
    expect(sources).toContain('DevicesPage');
    expect(sources).toContain('SettingsPage');
    expect(sources).not.toContain('DevicePage');
    expect(sources).not.toContain('FilePage');
    expect(sources).not.toContain('LoginPage');
    expect(sources).not.toContain('SharePage');
  });
});
