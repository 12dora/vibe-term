import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '../lib/fetch-like';
import { CloudflareDnsClient } from './cloudflare-dns';

describe('CloudflareDnsClient', () => {
  test('walks labels to find a zone and creates/deletes TXT records', async () => {
    const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const auth = new Headers(init?.headers).get('authorization');
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body, auth });
      if (url.includes('/zones?name=www.example.com')) {
        return json({ success: true, result: [] });
      }
      if (url.includes('/zones?name=example.com')) {
        return json({ success: true, result: [{ id: 'zone-1', name: 'example.com' }] });
      }
      if (method === 'POST' && url.endsWith('/zones/zone-1/dns_records')) {
        return json({ success: true, result: { id: 'rec-9' } });
      }
      if (method === 'DELETE' && url.endsWith('/zones/zone-1/dns_records/rec-9')) {
        return json({ success: true, result: { id: 'rec-9' } });
      }
      if (method === 'GET' && url.endsWith('/zones/zone-1')) {
        return json({
          success: true,
          result: { id: 'zone-1', name_servers: ['ns1.example.com', 'ns2.example.com'] },
        });
      }
      return json({ success: false, errors: [{ message: 'unexpected' }] }, 400);
    };

    const dns = new CloudflareDnsClient(fetchImpl);
    const zoneId = await dns.findZoneId('tok', 'www.example.com');
    expect(zoneId).toBe('zone-1');
    const recordId = await dns.createTxt('tok', zoneId, '_acme-challenge.www.example.com', 'abc');
    expect(recordId).toBe('rec-9');
    await dns.deleteRecord('tok', zoneId, recordId);
    expect(await dns.getNameServers('tok', zoneId)).toEqual(['ns1.example.com', 'ns2.example.com']);

    expect(calls[0]?.url).toBe('https://api.cloudflare.com/client/v4/zones?name=www.example.com');
    expect(calls[1]?.url).toBe('https://api.cloudflare.com/client/v4/zones?name=example.com');
    expect(calls.every((call) => call.auth === 'Bearer tok')).toBe(true);
    expect(calls[2]?.body).toEqual({
      type: 'TXT',
      name: '_acme-challenge.www.example.com',
      content: 'abc',
      ttl: 60,
    });
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
