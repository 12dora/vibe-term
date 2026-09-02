import { describe, expect, test } from 'bun:test';
import { DnspodDnsClient } from './dnspod-dns';

describe('DnspodDnsClient', () => {
  test('walks labels to find a zone and creates/deletes TXT records', async () => {
    const calls: Array<{ url: string; method: string; body: string; ua: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const ua = new Headers(init?.headers).get('user-agent');
      const body = String(init?.body ?? '');
      calls.push({ url, method, body, ua });
      const params = new URLSearchParams(body);
      if (url.endsWith('/Domain.Info') && params.get('domain') === 'www.example.com') {
        return json({ status: { code: '13', message: 'domain error' } });
      }
      if (url.endsWith('/Domain.Info') && params.get('domain') === 'example.com') {
        return json({
          status: { code: '1', message: 'ok' },
          domain: {
            id: '9',
            name: 'example.com',
            dnspod_ns: ['ns3.dnsv3.com', 'ns4.dnsv3.com'],
          },
        });
      }
      if (url.endsWith('/Record.Create')) {
        expect(params.get('sub_domain')).toBe('_acme-challenge.www');
        expect(params.get('record_type')).toBe('TXT');
        expect(params.get('record_line_id')).toBe('0');
        expect(params.get('ttl')).toBe('600');
        expect(params.get('value')).toBe('abc');
        return json({ status: { code: '1' }, record: { id: 88 } });
      }
      if (url.endsWith('/Record.Remove')) {
        expect(params.get('domain')).toBe('example.com');
        expect(params.get('record_id')).toBe('88');
        return json({ status: { code: '1' } });
      }
      return json({ status: { code: '0', message: 'unexpected' } }, 400);
    };

    const dns = new DnspodDnsClient({
      fetch: fetchImpl,
      email: 'ops@example.com',
      version: '9.9.9',
    });
    const created = await dns.createTxt(
      { id: '100', token: 'tok' },
      '_acme-challenge.www.example.com',
      'abc'
    );
    expect(created).toEqual({ recordId: '88', zone: 'example.com' });
    await dns.deleteTxt({ id: '100', token: 'tok' }, created);
    expect(await dns.getNameServers({ id: '100', token: 'tok' }, 'example.com')).toEqual([
      'ns3.dnsv3.com',
      'ns4.dnsv3.com',
    ]);

    expect(calls[0]?.url).toBe('https://dnsapi.cn/Domain.Info');
    expect(calls.every((call) => call.method === 'POST')).toBe(true);
    expect(calls.every((call) => call.ua === 'tmex/9.9.9 (ops@example.com)')).toBe(true);
    expect(calls.every((call) => call.body.includes('login_token=100%2Ctok'))).toBe(true);
    expect(calls.every((call) => call.body.includes('format=json'))).toBe(true);
  });

  test('falls back to Domain.List when Info misses every suffix', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const params = new URLSearchParams(String(init?.body ?? ''));
      if (url.endsWith('/Domain.Info')) {
        return json({ status: { code: '13', message: 'not found' } });
      }
      if (url.endsWith('/Domain.List')) {
        return json({
          status: { code: '1' },
          domains: [{ name: 'example.com', punycode: 'example.com' }],
        });
      }
      if (url.endsWith('/Record.Create')) {
        expect(params.get('domain')).toBe('example.com');
        return json({ status: { code: '1' }, record: { id: '1' } });
      }
      return json({ status: { code: '0' } }, 400);
    };
    const dns = new DnspodDnsClient({ fetch: fetchImpl, version: '1.0.0' });
    const created = await dns.createTxt(
      { id: '1', token: 't' },
      '_acme-challenge.example.com',
      'v'
    );
    expect(created.zone).toBe('example.com');
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
