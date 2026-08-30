import { describe, expect, test } from 'bun:test';
import { setMeshRequestContext } from './mesh-deps';
import {
  X_TMEX_MESH_PEER,
  attachMeshPeerMarker,
  isPeerInboundRequest,
  readMeshPeerMarker,
  stripMeshPeerMarkerFromRequest,
} from './peer-request-marker';

describe('peer-request-marker', () => {
  test('strip 去掉外部请求上的伪造标记', () => {
    const req = new Request('http://localhost/api/mesh-internal/tmux/pane-info', {
      headers: { [X_TMEX_MESH_PEER]: 'forged' },
    });
    expect(readMeshPeerMarker(req)).toBe('forged');
    const stripped = stripMeshPeerMarkerFromRequest(req);
    expect(readMeshPeerMarker(stripped)).toBeNull();
  });

  test('attach 写入 fromNodeId', () => {
    const headers = attachMeshPeerMarker({ accept: '*/*' }, 'peer-a');
    expect(headers[X_TMEX_MESH_PEER]).toBe('peer-a');
  });

  test('clientIp peer: 前缀视为 inbound', () => {
    const req = new Request('http://localhost/api/x');
    setMeshRequestContext(req, { via: 'peer-a', clientIp: 'peer:peer-a' });
    expect(isPeerInboundRequest(req)).toBe(true);
    const ext = new Request('http://localhost/api/x');
    setMeshRequestContext(ext, { via: 'self', clientIp: '127.0.0.1' });
    expect(isPeerInboundRequest(ext)).toBe(false);
  });
});
