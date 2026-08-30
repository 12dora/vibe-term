// entry（self）网关的 agent store：mesh 下 agent 会话——含绑定远端 pane 的那些——
// 全部由 entry 持有并运行，所以侧边栏与 Agent 标签无论挂在哪个 node 的运行时下，
// 读写的都必须是这一份 store（node 维度靠 session.nodeId 过滤，见 `sessionsForNode`）。
//
// `appNodeRuntimes.get()` 不改引用计数；self 运行时由宿主根（`AppRoot`）长期持有，
// 这里永远拿得到同一个实例。

import { SELF_NODE_ID } from '@tmex/api-client';
import type { AgentStore } from '@tmex/stores';
import { setAgentHostStore } from '@tmex/stores';
import { appNodeRuntimes } from './node-runtimes';

export function selfAgentStore(): AgentStore {
  return appNodeRuntimes.get(SELF_NODE_ID).runtime.stores.agent;
}

// 包内（panels）只拿得到自己所在的路由 runtime，经解析器把 self 的 store 递进去。
setAgentHostStore(selfAgentStore);
