import { describe, expect, test } from 'bun:test';
import { randomBytes, rootKeyFromSeed } from '../../../shared/src/auth';
import type { FetchLike } from './fetch-like';
import { sealAndUploadRelayPack } from './relay-pack-upload';
import type { RelayTenantSession } from './relay-session';

describe('sealAndUploadRelayPack', () => {
  test('requests join-material with scope=all', async () => {
    const paths: string[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}${url.search}`);
      return new Response(JSON.stringify({ error: { code: 'STOP' } }), { status: 500 });
    };
    const rootKey = rootKeyFromSeed(randomBytes(32));
    const session = {
      ctx: {} as never,
      baseUrl: 'http://127.0.0.1:19663',
      cookieHeader: 'sid=x',
      userId: 'user-1',
      rootKey,
      fetcher,
    } satisfies RelayTenantSession;
    await expect(
      sealAndUploadRelayPack({
        session,
        rootKey,
        kdfParams: { salt: randomBytes(16), memory_kib: 8, iterations: 1, parallelism: 1 },
      })
    ).rejects.toThrow();
    expect(paths[0]).toBe('/api/mesh/relay/join-material?scope=all');
  });
});
