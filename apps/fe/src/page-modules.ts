// 路由页模块的 loader。单独成模块是为了让路由表（main.tsx）与导航预热（NavLink / 空闲预热）
// 共用同一个函数引用：预热命中的必须是同一个 chunk，不能各写一份 import()。

import type { PageModuleLoader } from '@/use-page-module';

export const devicesPageModule: PageModuleLoader = () => import('./pages/DevicesPage');
export const devicePageModule: PageModuleLoader = () => import('./pages/DevicePage');
export const settingsPageModule: PageModuleLoader = () => import('./pages/SettingsPage');
export const filePageModule: PageModuleLoader = () => import('./pages/FilePage');
export const loginPageModule: PageModuleLoader = () => import('./pages/LoginPage');

/**
 * 首帧之后空闲预热的路由：只放侧栏一定会点到的设备页与设置页。
 * 终端页（DevicePage）拖着 Ghostty WASM、文件页拖着 highlight.js，
 * 提前拉下来只会跟首屏的数据请求抢带宽，那两个仍旧只在 hover / 导航时才加载。
 */
export const IDLE_PRELOAD_PAGE_MODULES: readonly PageModuleLoader[] = [
  devicesPageModule,
  settingsPageModule,
];
