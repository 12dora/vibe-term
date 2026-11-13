import { describe, expect, test } from 'bun:test';
import { MESH_VIA_SELF, setMeshRequestContext } from './mesh-deps';
import { isLocalRelayStatusRequest } from './relay-routes-input';

function statusReq(headers: Record<string, string>, clientIp: string, trustProxy = true): Request {
  const req = new Request('http://localhost/api/mesh/relay/status', { headers });
  setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp, trustProxy });
  return req;
}

describe('isLocalRelayStatusRequest', () => {
  test('direct loopback socket without forwarding headers is local', () => {
    expect(isLocalRelayStatusRequest(statusReq({}, '127.0.0.1'))).toBe(true);
  });

  test('forwarded requests claiming loopback are not local', () => {
    for (const headers of [
      { 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '198.51.100.7' },
      { 'cf-connecting-ip': '127.0.0.1' },
      { 'x-forwarded-for': '127.0.0.1' },
    ] as Record<string, string>[]) {
      expect(isLocalRelayStatusRequest(statusReq(headers, '127.0.0.1'))).toBe(false);
    }
  });
});
