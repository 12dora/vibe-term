// 默认应用运行时：单实例宿主（开源 fe）的全局实例。
// 首次 import 即构造，各 store 原名导出于 index.ts —— 与拆包前模块级单例时序等价。

import { type AppRuntime, createAppRuntime } from './app-runtime';

export const defaultRuntime: AppRuntime = createAppRuntime();
