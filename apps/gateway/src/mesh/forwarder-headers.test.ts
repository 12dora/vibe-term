import { describe, expect, test } from 'bun:test';
import { CLIENT_SOURCE_LOCAL, X_TMEX_CLIENT_SOURCE } from './client-source';
import { copyUpstreamHeaders, filterRequestHeaders } from './forwarder-headers';
import {
  MESH_FORWARD_CSP,
  MESH_VIA_SELF,
  X_TMEX_SET_SESSION,
  setMeshRequestContext,
} from './mesh-deps';

function reqWith(headers: Record<string, string>, ip = '127.0.0.1'): Request {
  const req = new Request('http://localhost/n/peer/api/file', { headers });
  setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: ip });
  return req;
}

describe('copyUpstreamHeaders', () => {
  test('SVG/HTML → octet-stream attachment；PNG 放行；未知头丢弃；CSP 固定', () => {
    const svg = copyUpstreamHeaders(
      new Response('<svg></svg>', {
        headers: {
          'content-type': 'image/svg+xml',
          'x-evil': '1',
          'cache-control': 'no-store',
          'set-cookie': 'stolen=1',
          [X_TMEX_SET_SESSION]: 'sid;60',
        },
      })
    );
    expect(svg.get('content-type')).toBe('application/octet-stream');
    expect(svg.get('content-disposition')).toBe('attachment');
    expect(svg.get('x-evil')).toBeNull();
    expect(svg.get('set-cookie')).toBeNull();
    expect(svg.get(X_TMEX_SET_SESSION)).toBeNull();
    expect(svg.get('content-security-policy')).toBe(MESH_FORWARD_CSP);
    expect(svg.get('x-content-type-options')).toBe('nosniff');
    expect(svg.get('cache-control')).toBe('no-store');

    const html = copyUpstreamHeaders(
      new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
    );
    expect(html.get('content-type')).toBe('application/octet-stream');
    expect(html.get('content-disposition')).toBe('attachment');

    const png = copyUpstreamHeaders(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png', 'content-disposition': 'inline' },
      })
    );
    expect(png.get('content-type')).toBe('image/png');
    expect(png.get('content-disposition')).toBe('inline');
  });

  test('允许 x-tmex-* 透传，空 content-type 当 octet-stream', () => {
    const headers = copyUpstreamHeaders(
      new Response('x', { headers: { 'x-tmex-foo': 'bar', etag: '"a"' } })
    );
    expect(headers.get('x-tmex-foo')).toBe('bar');
    expect(headers.get('etag')).toBe('"a"');
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('content-disposition')).toBe('attachment');
  });
});

describe('filterRequestHeaders', () => {
  test('丢掉 cookie/authorization/host/connection/upgrade/cf-* / 转发头', () => {
    const out = filterRequestHeaders(
      reqWith(
        {
          cookie: 'tmex_s_self=abc',
          authorization: 'Bearer x',
          host: 'evil.example',
          connection: 'keep-alive',
          upgrade: 'websocket',
          'proxy-authorization': 'x',
          'x-forwarded-for': '1.1.1.1',
          accept: 'image/*',
          'cf-connecting-ip': '203.0.113.9',
          'cf-access-jwt-assertion': 'header.payload.sig',
          'cf-access-authenticated-user-email': 'user@example.com',
          'cf-ray': 'abc123',
          'x-tmex-client-source': 'local',
        },
        '203.0.113.9'
      )
    );
    expect(out.cookie).toBeUndefined();
    expect(out.authorization).toBeUndefined();
    expect(out.host).toBeUndefined();
    expect(out.connection).toBeUndefined();
    expect(out.accept).toBe('image/*');
    expect(out['cf-connecting-ip']).toBeUndefined();
    expect(out['cf-access-jwt-assertion']).toBeUndefined();
    expect(out['cf-access-authenticated-user-email']).toBeUndefined();
    expect(out['cf-ray']).toBeUndefined();
    expect(out['x-tmex-client-source']).toBeUndefined();
    expect(out['proxy-authorization']).toBeUndefined();
    expect(out['x-forwarded-for']).toBeUndefined();
  });

  test('受信本机入口盖上 x-tmex-client-source: local，浏览器伪造会被丢掉再盖回', () => {
    const out = filterRequestHeaders(
      reqWith({ accept: '*/*', [X_TMEX_CLIENT_SOURCE]: 'forged' }, '127.0.0.1')
    );
    expect(out[X_TMEX_CLIENT_SOURCE]).toBe(CLIENT_SOURCE_LOCAL);
    expect(out.accept).toBe('*/*');
  });
});
