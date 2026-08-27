// 单连接宿主 / 单测用的默认应用运行时。
//
// 注意：本模块 **不再** 从 `@tmex/stores` 主入口导出——多 node 宿主必须经
// `NodeConnectionManager` + `RuntimeProvider` 拿 runtime，import 主入口不应再顺带
// 构造一个连向 entry 的全局 runtime。需要单实例语义的消费方显式
// `import ... from '@tmex/stores/default-runtime'`。

import { type AppRuntime, createAppRuntime } from './app-runtime';

export const defaultRuntime: AppRuntime = createAppRuntime();

export const useUIStore = defaultRuntime.stores.ui;
export const useSiteStore = defaultRuntime.stores.site;
export const useTmuxStore = defaultRuntime.stores.tmux;
export const useAgentStore = defaultRuntime.stores.agent;
export const useFileTreeStore = defaultRuntime.stores.fileTree;
