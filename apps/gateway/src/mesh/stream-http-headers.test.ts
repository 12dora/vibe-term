import { describe, expect, test } from 'bun:test';
import { CLIENT_SOURCE_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { CLIENT_SOURCE_LOCAL } from './client-source';
import {
  headerRecord,
  stringHeaders,
  stripForwardedRequestHeaders,
  stripSetCookieHeaders,
} from './stream-http-headers';

describe('stream-http-headers', () => {
  test('stripForwardedRequestHeaders 丢掉 hop-by-hop / via / mesh-peer / 转发头', () => {
    const out = stripForwardedRequestHeaders({
      cookie: 'secret=1',
      authorization: 'Bearer x',
      host: 'evil.example',
      connection: 'keep-alive',
      upgrade: 'websocket',
      'x-vibeterm-via': 'peer',
      'x-tmex-via': 'legacy',
      'x-vibeterm-mesh-peer': 'aa'.repeat(16),
      'proxy-authorization': 'basic',
      'x-forwarded-for': '1.2.3.4',
      [CLIENT_SOURCE_HEADER.name]: CLIENT_SOURCE_LOCAL,
      'content-type': 'application/json',
      'x-custom': 'keep',
    });
    expect(out.cookie).toBeUndefined();
    expect(out.authorization).toBeUndefined();
    expect(out.host).toBeUndefined();
    expect(out.connection).toBeUndefined();
    expect(out.upgrade).toBeUndefined();
    expect(out['x-vibeterm-via']).toBeUndefined();
    expect(out['x-tmex-via']).toBeUndefined();
    expect(out['x-vibeterm-mesh-peer']).toBeUndefined();
    expect(out['proxy-authorization']).toBeUndefined();
    expect(out['x-forwarded-for']).toBeUndefined();
    expect(out[CLIENT_SOURCE_HEADER.name]).toBe(CLIENT_SOURCE_LOCAL);
    expect(out['content-type']).toBe('application/json');
    expect(out['x-custom']).toBe('keep');
  });

  test('stripForwardedRequestHeaders 对空输入返回空对象', () => {
    expect(stripForwardedRequestHeaders()).toEqual({});
    expect(stripForwardedRequestHeaders(null)).toEqual({});
  });

  test('stripSetCookieHeaders 只丢掉 set-cookie', () => {
    expect(
      stripSetCookieHeaders({
        'set-cookie': 'stolen=1',
        'content-type': 'text/plain',
        'Set-Cookie': 'also=1',
      })
    ).toEqual({ 'content-type': 'text/plain' });
  });

  test('stringHeaders 只拷贝字符串值', () => {
    expect(stringHeaders({ a: 'ok', b: 1, c: null, d: 'keep' })).toEqual({ a: 'ok', d: 'keep' });
    expect(stringHeaders(['nope'])).toEqual({});
    expect(stringHeaders(null)).toEqual({});
  });

  test('headerRecord 丢掉 Headers 里的 set-cookie', () => {
    const headers = new Headers({
      'content-type': 'text/plain',
      'set-cookie': 'x=1',
    });
    expect(headerRecord(headers)).toEqual({ 'content-type': 'text/plain' });
  });
});
