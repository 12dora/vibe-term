import { describe, expect, test } from 'bun:test';
import {
  PROBE_DEFAULT_GRACE_MS,
  type ProbeFetch,
  SUGGESTED_HIGH_PORTS,
  candidateUrls,
  isLoopbackHostname,
  parseProbeTarget,
  pickSuggestedPort,
  pickSuggestedPortAvoiding,
  probeAddressPorts,
} from './port-candidates';

type Answer = { port: number; delayMs?: number; body?: unknown; status?: number };

/** 按端口应答的假 fetch：没列出的端口一直挂到被中止。 */
function fakeFetch(
  answers: Answer[],
  seen: string[] = []
): { fetchImpl: ProbeFetch; seen: string[] } {
  const table = new Map(answers.map((item) => [item.port, item]));
  const fetchImpl: ProbeFetch = (input, init) => {
    const url = new URL(input);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    seen.push(`${port}${url.pathname}`);
    const answer = table.get(port);
    const signal = init.signal as AbortSignal | undefined;
    return new Promise<Response>((resolve, reject) => {
      const fail = () => reject(new Error('aborted'));
      if (!answer) {
        signal?.addEventListener('abort', fail, { once: true });
        return;
      }
      const timer = setTimeout(() => {
        resolve(
          Response.json(answer.body ?? { ok: true, status: 'ok' }, { status: answer.status ?? 200 })
        );
      }, answer.delayMs ?? 0);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          fail();
        },
        { once: true }
      );
    });
  };
  return { fetchImpl, seen };
}

const FAST = { timeoutMs: 120, graceMs: 20, staggerMs: 5 } as const;

describe('parseProbeTarget', () => {
  test('bare host becomes https and keeps 443 implicit', () => {
    expect(parseProbeTarget('relay.example.com')).toEqual({
      base: 'https://relay.example.com',
      protocol: 'https:',
      explicitPort: null,
      port: 443,
    });
  });

  test('bare loopback host becomes http', () => {
    expect(parseProbeTarget('127.0.0.1:19883')).toEqual({
      base: 'http://127.0.0.1:19883',
      protocol: 'http:',
      explicitPort: 19883,
      port: 19883,
    });
  });

  test('explicit https port is kept and reported as explicit', () => {
    expect(parseProbeTarget('https://Relay.Example.com:13443/base/')).toEqual({
      base: 'https://relay.example.com:13443/base',
      protocol: 'https:',
      explicitPort: 13443,
      port: 13443,
    });
  });

  test('explicit :443 counts as explicit even though canonicalisation drops it', () => {
    const target = parseProbeTarget('https://relay.example.com:443');
    expect(target.base).toBe('https://relay.example.com');
    expect(target.explicitPort).toBe(443);
  });

  test('rejects empty and non-http schemes', () => {
    expect(() => parseProbeTarget('  ')).toThrow();
    expect(() => parseProbeTarget('ftp://relay.example.com')).toThrow();
  });
});

describe('candidateUrls', () => {
  test('no port yields 443 plus every suggested port', () => {
    const urls = candidateUrls('https://relay.example.com');
    expect(urls[0]).toBe('https://relay.example.com');
    expect(urls).toHaveLength(SUGGESTED_HIGH_PORTS.length + 1);
    expect(urls).toContain('https://relay.example.com:13443');
  });

  test('explicit port yields exactly one candidate', () => {
    expect(candidateUrls('https://relay.example.com:13443')).toEqual([
      'https://relay.example.com:13443',
    ]);
  });

  test('loopback http yields exactly one candidate', () => {
    expect(candidateUrls('http://127.0.0.1:19883')).toEqual(['http://127.0.0.1:19883']);
  });
});

describe('probeAddressPorts', () => {
  test('explicit port is confirmed and never swept', async () => {
    const { fetchImpl, seen } = fakeFetch([{ port: 13443, body: { ok: true } }]);
    const result = await probeAddressPorts('https://relay.example.com:13443', {
      kind: 'relay',
      fetchImpl,
      ...FAST,
    });
    expect(result).toEqual({
      url: 'https://relay.example.com:13443',
      port: 13443,
      explicit: true,
      triedPorts: [13443],
    });
    expect(seen).toEqual(['13443/api/relay/health']);
  });

  test('explicit port that never answers returns a null url', async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await probeAddressPorts('https://relay.example.com:13443', {
      kind: 'relay',
      fetchImpl,
      ...FAST,
    });
    expect(result).toEqual({
      url: null,
      port: null,
      explicit: true,
      triedPorts: [13443],
    });
  });

  test('443 wins inside the grace window without touching candidates', async () => {
    const { fetchImpl, seen } = fakeFetch([{ port: 443, body: { status: 'ok' } }]);
    const result = await probeAddressPorts('hub.example.com', {
      kind: 'hub',
      fetchImpl,
      ...FAST,
    });
    expect(result.url).toBe('https://hub.example.com');
    expect(result.port).toBe(443);
    expect(result.explicit).toBe(false);
    expect(result.triedPorts).toEqual([443]);
    expect(seen).toEqual(['443/healthz']);
  });

  test('dead 443 falls through to a suggested candidate port', async () => {
    const { fetchImpl } = fakeFetch([{ port: 13443, body: { ok: true } }]);
    const result = await probeAddressPorts('relay.example.com', {
      kind: 'relay',
      fetchImpl,
      ...FAST,
    });
    expect(result.url).toBe('https://relay.example.com:13443');
    expect(result.port).toBe(13443);
    expect(result.explicit).toBe(false);
    expect(result.triedPorts).toContain(443);
    expect(result.triedPorts).toContain(13443);
  });

  test('a healthy body is required: 200 with ok=false loses', async () => {
    const { fetchImpl } = fakeFetch([
      { port: 443, body: { ok: false } },
      { port: 8443, body: { ok: true } },
    ]);
    const result = await probeAddressPorts('relay.example.com', {
      kind: 'relay',
      fetchImpl,
      ...FAST,
    });
    expect(result.port).toBe(8443);
  });

  test('hub probe rejects a relay-shaped body', async () => {
    const { fetchImpl } = fakeFetch([{ port: 443, body: { ok: true } }]);
    const result = await probeAddressPorts('hub.example.com', {
      kind: 'hub',
      fetchImpl,
      ...FAST,
    });
    expect(result.url).toBeNull();
  });

  test('non-2xx never wins', async () => {
    const { fetchImpl } = fakeFetch([{ port: 443, body: { status: 'ok' }, status: 503 }]);
    const result = await probeAddressPorts('hub.example.com', { kind: 'hub', fetchImpl, ...FAST });
    expect(result.url).toBeNull();
  });

  test('nothing answers returns null with every port listed', async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await probeAddressPorts('relay.example.com', {
      kind: 'relay',
      fetchImpl,
      ...FAST,
    });
    expect(result).toEqual({
      url: null,
      port: null,
      explicit: false,
      triedPorts: [443, ...SUGGESTED_HIGH_PORTS],
    });
  });

  test('443 answering after the grace window still wins over silent candidates', async () => {
    const { fetchImpl } = fakeFetch([{ port: 443, delayMs: 40, body: { status: 'ok' } }]);
    const result = await probeAddressPorts('hub.example.com', {
      kind: 'hub',
      fetchImpl,
      timeoutMs: 200,
      graceMs: 10,
      staggerMs: 2,
    });
    expect(result.url).toBe('https://hub.example.com');
    expect(result.port).toBe(443);
  });

  test('loopback http probes port 80 only', async () => {
    const { fetchImpl, seen } = fakeFetch([{ port: 80, body: { ok: true } }]);
    const result = await probeAddressPorts('http://localhost', {
      kind: 'relay',
      fetchImpl,
      ...FAST,
    });
    expect(result).toEqual({
      url: 'http://localhost',
      port: 80,
      explicit: false,
      triedPorts: [80],
    });
    expect(seen).toEqual(['80/api/relay/health']);
  });

  test('resolveDialUrl rewrites the request target but not the reported url', async () => {
    const seen: string[] = [];
    const { fetchImpl } = fakeFetch([{ port: 19663, body: { ok: true } }], seen);
    const result = await probeAddressPorts('https://relay.example.com:13443', {
      kind: 'relay',
      fetchImpl,
      resolveDialUrl: () => 'http://127.0.0.1:19663',
      ...FAST,
    });
    expect(result.url).toBe('https://relay.example.com:13443');
    expect(seen).toEqual(['19663/api/relay/health']);
  });

  test('an external abort signal stops the sweep', async () => {
    const { fetchImpl } = fakeFetch([]);
    const ac = new AbortController();
    ac.abort();
    const result = await probeAddressPorts('relay.example.com', {
      kind: 'relay',
      fetchImpl,
      signal: ac.signal,
      ...FAST,
    });
    expect(result.url).toBeNull();
  });

  test('a custom port list replaces the built-in candidates', async () => {
    const { fetchImpl } = fakeFetch([{ port: 9443, body: { ok: true } }]);
    const result = await probeAddressPorts('relay.example.com', {
      kind: 'relay',
      fetchImpl,
      ports: [9443],
      ...FAST,
    });
    expect(result.port).toBe(9443);
    expect(result.triedPorts).toEqual([443, 9443]);
  });
});

describe('suggested port helpers', () => {
  test('grace default is under a second so the common case stays fast', () => {
    expect(PROBE_DEFAULT_GRACE_MS).toBeLessThan(1000);
  });

  test('every suggested port is a high, non-ephemeral port', () => {
    for (const port of SUGGESTED_HIGH_PORTS) {
      expect(port).toBeGreaterThan(1023);
      expect(port).toBeLessThan(32768);
    }
  });

  test('pickSuggestedPort is deterministic under an injected rng', () => {
    expect(pickSuggestedPort(() => 0)).toBe(SUGGESTED_HIGH_PORTS[0]);
    expect(pickSuggestedPort(() => 0.999999)).toBe(
      SUGGESTED_HIGH_PORTS[SUGGESTED_HIGH_PORTS.length - 1]
    );
  });

  test('pickSuggestedPortAvoiding skips used ports', () => {
    const used = [SUGGESTED_HIGH_PORTS[0], SUGGESTED_HIGH_PORTS[1]];
    expect(pickSuggestedPortAvoiding(used, () => 0)).toBe(SUGGESTED_HIGH_PORTS[2]);
  });

  test('pickSuggestedPortAvoiding falls back when everything is used', () => {
    expect(SUGGESTED_HIGH_PORTS).toContain(
      pickSuggestedPortAvoiding([...SUGGESTED_HIGH_PORTS], () => 0.5)
    );
  });

  test('isLoopbackHostname covers the normalizeRelayUrl set', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) {
      expect(isLoopbackHostname(host)).toBe(true);
    }
    expect(isLoopbackHostname('relay.example.com')).toBe(false);
  });
});
