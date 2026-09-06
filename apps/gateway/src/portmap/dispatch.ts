import type { LinkStream } from '@tmex/shared/link';
import { acceptTcpStream } from './accept-tcp-stream';
import { getPortMapNodeBinding } from './binding';

/** 端口映射的入站流：由本节点的 portmap 绑定（按自身 nodeId 注册）接手。 */
export function dispatchTcpStream(
  stream: LinkStream,
  ctx: { peerNodeId: string; selfNodeId: string }
): void {
  const binding = getPortMapNodeBinding(ctx.selfNodeId);
  if (!binding) {
    stream.reset('portmap-not-configured');
    return;
  }
  void acceptTcpStream(stream, { peerNodeId: ctx.peerNodeId, exports: binding.exports });
}
