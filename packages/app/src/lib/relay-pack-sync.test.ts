import './test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { decodeBase64url, generateEd25519KeyPair } from '../../../shared/src/auth';
import { verifyRelayKeyLogAppend } from '../../../shared/src/relay';
import type { FetchLike } from './fetch-like';
import { type LocalAuthContext, openLocalAuth } from './local-auth';
import { syncRelayPackHead } from './relay-pack-sync';

const RELAY_URL = 'https://relay.example:13443';
const TENANT_ID = 'ab'.repeat(16);
const TOKEN = new Uint8Array(32).fill(1);
const LOG_KEY = new Uint8Array(32).fill(3);
const handles: LocalAuthContext[] = [];

afterEach(() => {
  for (const auth of handles.splice(0)) auth.close();
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('syncRelayPackHead', () => {
  test('HTTP appends carry a node_id/node_sig that verifies with the local node key', async () => {
    const auth = await openLocalAuth({ memory: true });
    handles.push(auth);
    const identity = await ensureNodeIdentity(auth.identityStore);
    const user = await auth.userKeys.bootstrapUserWithSelfAdmit({
      username: 'pack-sync-member',
      password: 'pack-sync-password',
      identity,
    });
    const head = auth.keyLogStore.head(user.userId);
    if (!head || head.seq <= 0n) throw new Error('missing key log head');

    const published = new Map<string, { seq: number | string; blob: unknown }>();
    const posts: Array<Record<string, unknown>> = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        posts.push(body);
        published.set(String(body.seq), { seq: body.seq as number | string, blob: body.blob });
        return jsonRes({ ok: true });
      }
      const start = BigInt(url.searchParams.get('from_seq') ?? '1');
      const limit = Number(url.searchParams.get('limit') ?? '64');
      const records = [...published.values()]
        .filter((item) => BigInt(item.seq) >= start)
        .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
        .slice(0, limit);
      return jsonRes({ key_log: records, has_more: false });
    };

    await syncRelayPackHead({
      ctx: auth,
      userId: user.userId,
      relayUrl: RELAY_URL,
      tenantId: TENANT_ID,
      token: TOKEN,
      logKey: LOG_KEY,
      headSeq: head.seq,
      fetcher,
    });

    expect(posts.length).toBe(Number(head.seq));
    const other = generateEd25519KeyPair();
    for (const body of posts) {
      expect(body.node_id).toBe(identity.nodeIdHex);
      expect(typeof body.node_sig).toBe('string');
      const proof = {
        relayHost: 'relay.example:13443',
        tenantId: TENANT_ID,
        seq: BigInt(body.seq as number),
        envelope: body.blob as { v: 1; n: string; ct: string; epoch?: number },
      };
      expect(
        verifyRelayKeyLogAppend(decodeBase64url(String(body.node_sig)), identity.edPublicKey, proof)
      ).toBe(true);
      expect(
        verifyRelayKeyLogAppend(decodeBase64url(String(body.node_sig)), other.publicKey, proof)
      ).toBe(false);
    }
  });
});
