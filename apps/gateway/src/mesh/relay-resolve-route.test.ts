import { describe, expect, test } from 'bun:test';
import type { RelayDialContext } from './relay-dial';
import {
  type RelayResolveResult,
  handleRelayResolve,
  relayProbeDialUrl,
} from './relay-resolve-route';

function post(url: unknown): Request {
  return new Request('http://localhost/api/mesh/relay/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

/** 只在列出的端口上应答 `/api/relay/health`，其余端口挂到被中止。 */
function relayOn(ports: number[], seen: string[] = []) {
  return ((input: unknown, init?: RequestInit) => {
    const target = new URL(String(input));
    const port = Number(target.port || 443);
    seen.push(`${target.hostname}:${port}${target.pathname}`);
    if (ports.includes(port)) return Promise.resolve(Response.json({ ok: true }));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as typeof fetch;
}

async function resolveOf(res: Response): Promise<RelayResolveResult> {
  return (await res.json()) as RelayResolveResult;
}

describe('handleRelayResolve', () => {
  test('a portless address resolves to the candidate port that answers', async () => {
    const seen: string[] = [];
    const res = await handleRelayResolve(post('https://relay.example.com'), {
      fetchImpl: relayOn([13443], seen),
      timeoutMs: 150,
    });
    expect(res.status).toBe(200);
    const body = await resolveOf(res);
    expect(body.url).toBe('https://relay.example.com:13443');
    expect(body.port).toBe(13443);
    expect(body.explicit).toBe(false);
    expect(body.triedPorts).toContain(443);
    expect(seen).toContain('relay.example.com:443/api/relay/health');
  });

  test('an explicit port is confirmed and never swept', async () => {
    const seen: string[] = [];
    const res = await handleRelayResolve(post('https://relay.example.com:13443'), {
      fetchImpl: relayOn([13443], seen),
      timeoutMs: 150,
    });
    expect(await resolveOf(res)).toEqual({
      url: 'https://relay.example.com:13443',
      port: 13443,
      explicit: true,
      triedPorts: [13443],
    });
    expect(seen).toEqual(['relay.example.com:13443/api/relay/health']);
  });

  test('nothing answering returns a null url with every port tried', async () => {
    const res = await handleRelayResolve(post('https://relay.example.com:13443'), {
      fetchImpl: relayOn([]),
      timeoutMs: 150,
    });
    expect(await resolveOf(res)).toEqual({
      url: null,
      port: null,
      explicit: true,
      triedPorts: [13443],
    });
  });

  test('non-https and malformed addresses are INVALID_URL', async () => {
    for (const url of ['', '   ', 'http://relay.example.com', 'ftp://relay.example.com', 42]) {
      const res = await handleRelayResolve(post(url), {
        fetchImpl: relayOn([443]),
        timeoutMs: 150,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_URL');
    }
  });

  test('loopback http is allowed and probes its own port only', async () => {
    const seen: string[] = [];
    const res = await handleRelayResolve(post('http://127.0.0.1:19883'), {
      fetchImpl: relayOn([19883], seen),
      timeoutMs: 150,
    });
    expect(await resolveOf(res)).toEqual({
      url: 'http://127.0.0.1:19883',
      port: 19883,
      explicit: true,
      triedPorts: [19883],
    });
  });
});

describe('relayProbeDialUrl', () => {
  const ctx: RelayDialContext = {
    roles: { relay: true },
    relayPublicUrl: 'https://me.example.com:13443',
    gatewayPort: 19663,
  };

  test('candidates on the local relay host dial the loopback gateway', () => {
    expect(relayProbeDialUrl('https://me.example.com', ctx)).toBe('http://127.0.0.1:19663');
    expect(relayProbeDialUrl('https://me.example.com:2053', ctx)).toBe('http://127.0.0.1:19663');
  });

  test('other hosts are dialled as-is', () => {
    expect(relayProbeDialUrl('https://other.example.com:2053', ctx)).toBe(
      'https://other.example.com:2053'
    );
  });

  test('machines without the relay role never rewrite', () => {
    const node: RelayDialContext = { ...ctx, roles: { relay: false } };
    expect(relayProbeDialUrl('https://me.example.com', node)).toBe('https://me.example.com');
  });

  test('a relay without a public url never rewrites', () => {
    const bare: RelayDialContext = { ...ctx, relayPublicUrl: null };
    expect(relayProbeDialUrl('https://me.example.com', bare)).toBe('https://me.example.com');
  });
});
