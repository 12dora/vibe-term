// 宿主级 agent store 解析：mesh 下 agent 状态一律由 entry（self）网关持有，
// 远端 pane 的会话也由它运行，因此**所有** node 的界面都要读同一份 store。
//
// 包内组件只拿得到自己所在的路由 runtime，所以由宿主注册一次解析器（模式同
// `setSiteFallbackReader`）；未注册（standalone / 测试）时回落到调用方自己的 store，
// 单 node 宿主行为完全不变。

import type { AgentStore } from './agent';

let resolver: (() => AgentStore) | null = null;

/** 宿主注册「服务全部 node 的 agent store」；传 null 注销。 */
export function setAgentHostStore(next: (() => AgentStore) | null): void {
  resolver = next;
}

export function resolveAgentStore(fallback: AgentStore): AgentStore {
  return resolver?.() ?? fallback;
}
