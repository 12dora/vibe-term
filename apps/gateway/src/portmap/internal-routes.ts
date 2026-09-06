import { json } from '../api/http';
import { type ApiRoute, route } from '../api/route';
import { readMeshPeerMarker } from '../mesh/peer-request-marker';
import { type PortMapExportStoreLike, defaultPortMapExportStore } from './store';

export const MESH_INTERNAL_PORTMAP_PREFIX = '/api/mesh-internal/portmap';

export function meshInternalExportPath(mapId: string): string {
  return `${MESH_INTERNAL_PORTMAP_PREFIX}/exports/${encodeURIComponent(mapId)}`;
}

/**
 * A 删掉映射后顺手清 B 的放行行。peer 标记由接收侧按握手身份写入，只删 `fromNodeId` 与之相符的
 * 行——否则任一受信任节点都能替别人删。节点间转发只发 POST，所以同一条路由也接受 POST。
 */
export function createMeshInternalPortMapRoutes(
  exports: () => PortMapExportStoreLike = defaultPortMapExportStore
): ApiRoute[] {
  return [
    route({
      method: ['DELETE', 'POST'],
      path: `${MESH_INTERNAL_PORTMAP_PREFIX}/exports/:mapId`,
      handler: (req, params) => {
        const peer = readMeshPeerMarker(req);
        if (!peer) return json({ ok: false, removed: false, error: 'peer_mismatch' }, 403);
        const store = exports();
        const row = store.get(params.mapId);
        if (!row) return json({ ok: true, removed: true });
        if (row.fromNodeId !== peer) {
          return json({ ok: false, removed: false, error: 'peer_mismatch' }, 403);
        }
        store.remove(params.mapId);
        return json({ ok: true, removed: true });
      },
    }),
  ];
}
