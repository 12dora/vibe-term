// 远端窗格建会话前的准备：目标节点是否在线，以及代浏览器换一张窗格授权。

import {
  type StoredPaneGrant,
  mintPaneGrant,
  staticPaneGrantSource,
} from '../agent/pane-grant/client';
import { RemotePaneRuntime } from '../agent/remote-pane-runtime';
import { getMeshAgentBridge } from '../mesh/mesh-agent-bridge';
import { json } from './http';

export type RemotePanePrep =
  | { ok: true; grant: StoredPaneGrant | null }
  | { ok: false; response: Response };

export async function prepareRemotePane(
  req: Request,
  input: { nodeId: string; deviceId: string; paneId: string }
): Promise<RemotePanePrep> {
  const bridge = getMeshAgentBridge();
  const status = bridge?.lookupNode(input.nodeId) ?? 'unknown';
  if (status === 'unknown') {
    return { ok: false, response: json({ error: 'NODE_NOT_FOUND' }, 404) };
  }
  if (status === 'offline') {
    return { ok: false, response: json({ error: 'NODE_UNREACHABLE' }, 503) };
  }
  const minted = await mintPaneGrant(req, input);
  // 目标节点是旧版本或一时够不着：不带授权继续，旧版本本就不校验，新版本会在下次带 cookie
  // 的请求里补签。只有「浏览器没有目标节点的会话」需要用户介入，401 原样透出去。
  if (minted.kind === 'login-required') {
    return { ok: false, response: minted.response };
  }
  return { ok: true, grant: minted.kind === 'ok' ? minted.grant : null };
}

export function createRemotePaneRuntime(
  nodeId: string,
  deviceId: string,
  grant: StoredPaneGrant | null
): RemotePaneRuntime | null {
  const bridge = getMeshAgentBridge();
  if (!bridge) return null;
  return new RemotePaneRuntime(
    nodeId,
    deviceId,
    bridge.forwardInternalHttp,
    staticPaneGrantSource(grant)
  );
}
