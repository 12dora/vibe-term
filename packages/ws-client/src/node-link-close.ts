// 入口在 101 之后以 1011 关掉 `/n/<id>/ws` 的原因分两类：入口到不了目标 node（链路建不起来、
// failover 用尽、上游流被重置），以及浏览器这一侧的问题（慢客户端撑爆转发队列、浏览器 socket
// 已经写不进去）。只有前一类能算「这台 node 打不通」——后一类记进不可达退避会把一台好好的
// node 挡在 REST 门外，还让界面说「当前入口无法连接该节点」。
// 原因串与网关 `forwarder-ws-upgrade.ts` / `forwarder-failover.ts` / `adapted-ws-stream.ts` /
// `mesh-http.ts` 对齐。

export const NODE_LINK_FAILURE_CLOSE_CODE = 1011;

const NODE_LINK_FAILURE_REASONS = new Set([
  'node-unreachable',
  'forward-link-timeout',
  'no-stream',
  'reset',
  'stream-error',
]);

const NODE_LINK_FAILURE_PREFIX = 'failover-';

/** 这次关闭是否说明「入口到不了这台 node」。 */
export function isNodeLinkFailureClose(code: number | null, reason: string | null): boolean {
  if (code !== NODE_LINK_FAILURE_CLOSE_CODE || !reason) return false;
  return NODE_LINK_FAILURE_REASONS.has(reason) || reason.startsWith(NODE_LINK_FAILURE_PREFIX);
}
