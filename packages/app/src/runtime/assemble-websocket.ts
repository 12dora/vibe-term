import type { HubRuntime, HubServerWebSocket } from '../../../../apps/gateway/src/hub';
import {
  MESH_FORWARD_WS_KIND,
  MESH_GATEWAY_WS_KIND,
  MESH_REJECT_4401_KIND,
  MESH_SHARE_WS_KIND,
  MESH_VIA_SELF,
  MESH_WS_KIND,
  WS_CLOSE_LOGIN_REQUIRED,
} from '../../../../apps/gateway/src/mesh/mesh-deps';
import type { MeshRuntime } from '../../../../apps/gateway/src/mesh/mesh-runtime';
import type { RelayRuntime, RelayServerWebSocket } from '../../../../apps/gateway/src/relay';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import type { GatewaySession } from '../../../../apps/gateway/src/ws/gateway-session';
import type { ShareScope } from '../../../../packages/shared/src/share';

export type GatewayWsAuth = Pick<MeshRuntime, 'websocket' | 'touchSocket'> & {
  registerGatewaySession?: MeshRuntime['registerGatewaySession'];
  unregisterGatewaySession?: MeshRuntime['unregisterGatewaySession'];
};

function socketKind(ws: { data?: unknown }): string | undefined {
  const kind = (ws.data as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' ? kind : undefined;
}

/** hub/relay 判定上行链路只读 `data.kind`；bun 那边是 unknown，这里只换视图不复制。 */
const uplinkView = (ws: { data?: unknown }) => ws as { data?: { kind?: string } };

function isMeshKind(kind: string | undefined): boolean {
  return (
    kind === MESH_WS_KIND ||
    kind === MESH_FORWARD_WS_KIND ||
    kind === MESH_REJECT_4401_KIND ||
    kind === MESH_GATEWAY_WS_KIND ||
    kind === MESH_SHARE_WS_KIND
  );
}

/** 网关会话承载的两种 socket：常规会话与分享连接，都要接到 gateway 的 ws 处理。 */
function isGatewayBoundKind(kind: string | undefined): boolean {
  return kind === MESH_GATEWAY_WS_KIND || kind === MESH_SHARE_WS_KIND;
}

/** 分享连接只带作用域开会话；常规会话额外登记进 SessionRegistry。 */
function openGatewayBound(
  gw: GatewayRuntime['websocket'],
  mesh: GatewayWsAuth,
  ws: Bun.ServerWebSocket<unknown>,
  kind: string | undefined
): void {
  const data = ws.data as {
    sid?: string;
    uid?: string;
    via?: string;
    cid?: string;
    scope?: ShareScope;
  };
  if (kind === MESH_SHARE_WS_KIND) {
    if (data.scope) gw.open(ws, { shareScope: data.scope });
    return;
  }
  gw.open(ws);
  const session = (ws.data as { session?: GatewaySession }).session;
  if (!data.sid || !data.uid || !session) return;
  const cid = typeof data.cid === 'string' && data.cid.trim() ? data.cid.trim() : '';
  const registered = mesh.registerGatewaySession?.({
    sid: data.sid,
    uid: data.uid,
    via: data.via ?? MESH_VIA_SELF,
    session,
    ...(cid ? { cid } : {}),
  });
  if (registered && !registered.ok) {
    gw.closeSession(session, WS_CLOSE_LOGIN_REQUIRED, registered.code);
  }
}

export function routeWebsocket(
  gateway: GatewayRuntime,
  mesh: GatewayWsAuth | null,
  hub: HubRuntime | null,
  relay: RelayRuntime | null
): GatewayRuntime['websocket'] {
  const gw = gateway.websocket;
  return {
    backpressureLimit: gw.backpressureLimit,
    closeOnBackpressureLimit: gw.closeOnBackpressureLimit,
    open(ws) {
      if (relay?.isUplinkSocket(uplinkView(ws))) {
        relay.handleUplinkOpen(ws as unknown as RelayServerWebSocket);
        return;
      }
      if (hub?.isUplinkSocket(uplinkView(ws))) {
        hub.handleUplinkOpen(ws as HubServerWebSocket);
        return;
      }
      const kind = socketKind(ws);
      if (!(mesh && isMeshKind(kind))) {
        gw.open(ws);
        return;
      }
      mesh.websocket.open(ws as never);
      if (isGatewayBoundKind(kind)) openGatewayBound(gw, mesh, ws, kind);
    },
    message(ws, message) {
      if (relay?.isUplinkSocket(uplinkView(ws))) {
        relay.handleUplinkMessage(ws as unknown as RelayServerWebSocket, message);
        return;
      }
      if (hub?.isUplinkSocket(uplinkView(ws))) {
        hub.handleUplinkMessage(ws as HubServerWebSocket, message);
        return;
      }
      const kind = socketKind(ws);
      if (mesh && isMeshKind(kind)) {
        if (isGatewayBoundKind(kind)) {
          if (!mesh.touchSocket(ws as never)) return;
          gw.message(ws, message);
          return;
        }
        mesh.websocket.message(ws as never, message);
        return;
      }
      if (mesh && !mesh.touchSocket(ws as never)) return;
      gw.message(ws, message);
    },
    drain(ws) {
      if (relay?.isUplinkSocket(uplinkView(ws))) {
        relay.handleUplinkDrain(ws as unknown as RelayServerWebSocket);
        return;
      }
      if (hub?.isUplinkSocket(uplinkView(ws))) {
        hub.handleUplinkDrain(ws as HubServerWebSocket);
        return;
      }
      if (mesh && isMeshKind(socketKind(ws)) && !isGatewayBoundKind(socketKind(ws))) {
        mesh.websocket.drain(ws as never);
        return;
      }
      gw.drain(ws);
    },
    close(ws, code, reason) {
      if (relay?.isUplinkSocket(uplinkView(ws))) {
        relay.handleUplinkClose(ws as unknown as RelayServerWebSocket, code, reason);
        return;
      }
      if (hub?.isUplinkSocket(uplinkView(ws))) {
        hub.handleUplinkClose(ws as HubServerWebSocket, code, reason);
        return;
      }
      if (mesh) {
        const session = (ws.data as { session?: GatewaySession }).session;
        if (session) mesh.unregisterGatewaySession?.(session);
        mesh.websocket.close(ws as never, code, reason);
        if (isMeshKind(socketKind(ws)) && !isGatewayBoundKind(socketKind(ws))) return;
      }
      gw.close(ws, code, reason);
    },
    closeSession(session, code, reason) {
      gw.closeSession(session, code, reason);
    },
  };
}
