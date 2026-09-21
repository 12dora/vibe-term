import { describe, expect, test } from 'bun:test';
import { getSelfRewrite, rewriteRequest, rewriteSelf } from './forwarder-rewrite';
import { MESH_VIA_SELF, getMeshRequestContext, setMeshRequestContext } from './mesh-deps';

const LOCAL = 'aa'.repeat(16);
const OTHER = 'bb'.repeat(16);

describe('forwarder-rewrite', () => {
  test('rewriteSelf 只改写本机或 via=self 前缀', () => {
    const self = rewriteSelf(new Request(`http://localhost/n/${LOCAL}/api/system/info`), LOCAL);
    expect(self).not.toBeNull();
    expect(new URL(self?.url ?? '').pathname).toBe('/api/system/info');

    const viaSelf = rewriteSelf(
      new Request(`http://localhost/n/${MESH_VIA_SELF}/api/healthz?x=1`),
      LOCAL
    );
    expect(viaSelf).not.toBeNull();
    expect(new URL(viaSelf?.url ?? '').pathname).toBe('/api/healthz');
    expect(new URL(viaSelf?.url ?? '').search).toBe('?x=1');

    expect(rewriteSelf(new Request(`http://localhost/n/${OTHER}/api/x`), LOCAL)).toBeNull();
    expect(rewriteSelf(new Request('http://localhost/api/x'), LOCAL)).toBeNull();
  });

  test('rewriteRequest 清掉 selfRewrite 并标 via=self', () => {
    const req = new Request('http://localhost/n/self/api/x?q=1');
    setMeshRequestContext(req, { via: OTHER, selfRewrite: '/api/x?q=1' });
    const inner = rewriteRequest(req, '/api/x?q=1');
    expect(new URL(inner.url).pathname).toBe('/api/x');
    expect(new URL(inner.url).search).toBe('?q=1');
    expect(getMeshRequestContext(inner).via).toBe(MESH_VIA_SELF);
    expect(getSelfRewrite(inner)).toBeNull();
  });
});
