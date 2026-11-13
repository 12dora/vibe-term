import { describe, expect, test } from 'bun:test';
import { CLIENT_SOURCE_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { FILE_RESPONSE_CSP } from '../files/safe-file-headers';
import {
  ENTRY_CLIENT_IP_HEADER,
  copyUpstreamHeaders,
  filterRequestHeaders,
  stampForwardedAuthHeaders,
} from './forwarder-headers';
import { MESH_VIA_SELF, SET_SESSION_HEADER, setMeshRequestContext } from './mesh-deps';

function reqWith(headers: Record<string, string>, ip = '127.0.0.1'): Request {
  const req = new Request('http://localhost/n/peer/api/file', { headers });
  setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: ip });
  return req;
}

function upstreamHeaders(upstream: Response, req = reqWith({})): Headers {
  return copyUpstreamHeaders(upstream, req);
}

describe('copyUpstreamHeaders', () => {
  test('SVG/HTML → octet-stream attachment；PNG 放行；未知头丢弃；CSP 固定', () => {
    const svg = upstreamHeaders(
      new Response('<svg></svg>', {
        headers: {
          'content-type': 'image/svg+xml',
          'x-evil': '1',
          'cache-control': 'no-store',
          'set-cookie': 'stolen=1',
          [SET_SESSION_HEADER.name]: 'sid;60',
        },
      })
    );
    expect(svg.get('content-type')).toBe('application/octet-stream');
    expect(svg.get('content-disposition')).toBe('attachment');
    expect(svg.get('x-evil')).toBeNull();
    expect(svg.get('set-cookie')).toBeNull();
    expect(svg.get(SET_SESSION_HEADER.name)).toBeNull();
    expect(svg.get('content-security-policy')).toBe(FILE_RESPONSE_CSP);
    expect(svg.get('x-content-type-options')).toBe('nosniff');
    expect(svg.get('cache-control')).toBe('no-store');

    const html = upstreamHeaders(
      new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
    );
    expect(html.get('content-type')).toBe('application/octet-stream');
    expect(html.get('content-disposition')).toBe('attachment');

    const png = upstreamHeaders(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png', 'content-disposition': 'inline' },
      })
    );
    expect(png.get('content-type')).toBe('image/png');
    expect(png.get('content-disposition')).toBe('inline');
  });

  test('SVG 只在入口请求是图片目的地时按 image/svg+xml 内联，导航打开仍是附件', () => {
    const svg = () => new Response('<svg></svg>', { headers: { 'content-type': 'image/svg+xml' } });
    const asImage = upstreamHeaders(svg(), reqWith({ 'sec-fetch-dest': 'image' }));
    expect(asImage.get('content-type')).toBe('image/svg+xml');
    expect(asImage.get('content-security-policy')).toBe(FILE_RESPONSE_CSP);
    expect(asImage.get('x-content-type-options')).toBe('nosniff');
    expect(asImage.get('vary')).toBe('Sec-Fetch-Dest');
    const asDocument = upstreamHeaders(svg(), reqWith({ 'sec-fetch-dest': 'document' }));
    expect(asDocument.get('content-type')).toBe('application/octet-stream');
    expect(asDocument.get('content-disposition')).toBe('attachment');
  });

  test('允许 x-vibeterm-* / x-tmex-* 透传，空 content-type 当 octet-stream', () => {
    const headers = upstreamHeaders(
      new Response('x', {
        headers: { 'x-vibeterm-foo': 'baz', 'x-tmex-foo': 'bar', etag: '"a"' },
      })
    );
    expect(headers.get('x-vibeterm-foo')).toBe('baz');
    expect(headers.get('x-tmex-foo')).toBe('bar');
    expect(headers.get('etag')).toBe('"a"');
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('content-disposition')).toBe('attachment');
  });

  test('gzip 归档强制 attachment 但保留 x.tar.gz 文件名', () => {
    const headers = upstreamHeaders(
      new Response(null, {
        headers: {
          'content-type': 'application/gzip',
          'content-disposition': 'attachment; filename="x.tar.gz"; filename*=UTF-8\'\'x.tar.gz',
        },
      })
    );
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('content-disposition')).toBe(
      'attachment; filename="x.tar.gz"; filename*=UTF-8\'\'x.tar.gz'
    );
  });

  test('UTF-8 filename* 经消毒后原样可解码', () => {
    const headers = upstreamHeaders(
      new Response(null, {
        headers: {
          'content-type': 'application/gzip',
          'content-disposition':
            'attachment; filename="__.tar.gz"; filename*=UTF-8\'\'%E6%8A%A5%E5%91%8A.tar.gz',
        },
      })
    );
    const disposition = headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment;')).toBe(true);
    const encoded = disposition.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded ?? '')).toBe('报告.tar.gz');
  });

  test('header 注入与路径穿越不会进入 Content-Disposition', () => {
    const crlf = upstreamHeaders(
      new Response('x', {
        headers: {
          'content-type': 'application/gzip',
          // 原始 CRLF 进不了 Headers；能带进来的只有 filename* 里的百分号编码
          'content-disposition': "attachment; filename*=UTF-8''evil%0D%0AX-Injected%3A%201.txt",
        },
      })
    );
    const value = crlf.get('content-disposition') ?? '';
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).not.toContain('\nX-Injected');

    const path = upstreamHeaders(
      new Response('x', {
        headers: {
          'content-type': 'image/png',
          'content-disposition': 'inline; filename="../../x.png"',
        },
      })
    );
    expect(path.get('content-type')).toBe('image/png');
    expect(path.get('content-disposition')).toContain('filename="....x.png"');
  });

  test('上游没有 filename 时强制下载分支只写裸 attachment', () => {
    const headers = upstreamHeaders(
      new Response('x', { headers: { 'content-type': 'application/gzip' } })
    );
    expect(headers.get('content-disposition')).toBe('attachment');
  });
});

describe('filterRequestHeaders', () => {
  test('丢掉 cookie/authorization/host/connection/upgrade/cf-* / 转发头', () => {
    const out = filterRequestHeaders(
      reqWith(
        {
          cookie: 'vibeterm_s_self=abc',
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

  test('入口不再声明 client-source，本机客户端伪造的同名头也被丢掉', () => {
    const out = filterRequestHeaders(
      reqWith(
        {
          accept: '*/*',
          [CLIENT_SOURCE_HEADER.name]: 'local',
          [CLIENT_SOURCE_HEADER.legacy]: 'local',
        },
        '127.0.0.1'
      )
    );
    expect(out[CLIENT_SOURCE_HEADER.name]).toBeUndefined();
    expect(out[CLIENT_SOURCE_HEADER.legacy]).toBeUndefined();
    expect(out.accept).toBe('*/*');
  });
});

describe('stampForwardedAuthHeaders', () => {
  test('登录路径写真实 IP，并保留 client 与 user-agent；伪造的入口 IP 被丢掉', () => {
    const req = reqWith(
      {
        'user-agent': 'VibeTerm/1',
        'x-vibeterm-client': 'cli',
        [ENTRY_CLIENT_IP_HEADER]: '1.2.3.4',
      },
      '203.0.113.9'
    );
    const headers = filterRequestHeaders(req);
    stampForwardedAuthHeaders(headers, req, '/api/auth/login');
    expect(headers[ENTRY_CLIENT_IP_HEADER]).toBe('203.0.113.9');
    expect(headers['user-agent']).toBe('VibeTerm/1');
    expect(headers['x-vibeterm-client']).toBe('cli');
  });

  test('非登录路径不盖入口 IP', () => {
    const req = reqWith({ [ENTRY_CLIENT_IP_HEADER]: '1.2.3.4' }, '203.0.113.9');
    const headers = filterRequestHeaders(req);
    stampForwardedAuthHeaders(headers, req, '/api/devices');
    expect(headers[ENTRY_CLIENT_IP_HEADER]).toBeUndefined();
    expect(Object.keys(headers).some((key) => key.toLowerCase() === ENTRY_CLIENT_IP_HEADER)).toBe(
      false
    );
  });
});
