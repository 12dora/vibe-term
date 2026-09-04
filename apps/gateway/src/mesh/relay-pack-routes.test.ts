import { describe, expect, test } from 'bun:test';
import { encodeBase64url, randomBytes } from '@tmex/shared/auth';
import { RELAY_PACK_MAX_BYTES } from '@tmex/shared/relay';
import { handleMeshRelayPack, parseMeshRelayPackBody } from './relay-pack-routes';
import type { RelaySecrets } from './relay-secrets';

const KDF = {
  salt: encodeBase64url(randomBytes(16)),
  memory_kib: 8,
  iterations: 1,
  parallelism: 1,
};

function packBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    sealed_pack: encodeBase64url(randomBytes(48)),
    kdf_params: KDF,
    root_epoch: 0,
    head_seq: 3,
    ...overrides,
  };
}

describe('parseMeshRelayPackBody', () => {
  test('accepts a well-formed body and optional urls', () => {
    const parsed = parseMeshRelayPackBody(packBody({ urls: ['https://relay.example', '', 1] }));
    expect(parsed?.root_epoch).toBe(0);
    expect(parsed?.head_seq).toBe(3);
    expect(parsed?.urls).toEqual(['https://relay.example']);
  });

  test('rejects malformed kdf, epoch, pack size', () => {
    expect(parseMeshRelayPackBody(null)).toBeNull();
    expect(parseMeshRelayPackBody(packBody({ kdf_params: { salt: 'zz' } }))).toBeNull();
    expect(parseMeshRelayPackBody(packBody({ root_epoch: -1 }))).toBeNull();
    expect(
      parseMeshRelayPackBody(
        packBody({ sealed_pack: encodeBase64url(new Uint8Array(RELAY_PACK_MAX_BYTES + 1)) })
      )
    ).toBeNull();
  });
});

describe('handleMeshRelayPack', () => {
  test('forwards to matching relays and reports mixed results', async () => {
    const calls: string[] = [];
    const secrets = {
      relayRows: () => [
        { url: 'https://relay-a.example', tenantId: 'aa'.repeat(16), priority: 0, kicked: false },
        { url: 'https://relay-b.example', tenantId: 'bb'.repeat(16), priority: 1, kicked: false },
      ],
      store: {
        getRelay: async (url: string) => ({
          url,
          tenantId: url.includes('relay-a') ? 'aa'.repeat(16) : 'bb'.repeat(16),
          token: new Uint8Array(32).fill(7),
        }),
      },
    } as unknown as RelaySecrets;
    const res = await handleMeshRelayPack(
      {
        secrets,
        fetchImpl: (async (input: RequestInfo | URL) => {
          const href = String(input);
          calls.push(href);
          if (href.includes('relay-a')) {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ error: { code: 'RELAY_PACK_EPOCH_MISMATCH' } }), {
            status: 409,
          });
        }) as typeof fetch,
      },
      new Request('http://self/api/mesh/relay/pack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(packBody()),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      results: Array<{ ok: boolean; code?: string }>;
    };
    expect(body.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(body.results.some((item) => item.ok)).toBe(true);
    expect(body.results.some((item) => item.code === 'RELAY_PACK_EPOCH_MISMATCH')).toBe(true);
  });

  test('returns 409 when no relays are configured', async () => {
    const secrets = {
      relayRows: () => [],
      store: { getRelay: async () => null },
    } as unknown as RelaySecrets;
    const res = await handleMeshRelayPack(
      { secrets },
      new Request('http://self/api/mesh/relay/pack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(packBody()),
      })
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('RELAY_NOT_CONFIGURED');
  });
});
