import { describe, expect, test } from 'bun:test';
import { callRelayEnroll, enrollPassThrough, revokedNodeIdsFrom } from './relay-enroll-call';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);

const certs = [
  { nodeId: A, revokedLogSeq: 3 },
  { nodeId: B, revokedLogSeq: null },
  { nodeId: C.toUpperCase(), revokedLogSeq: 9 },
];

describe('force_rotate 随带本机已吊销节点', () => {
  test('只取已吊销的证书，最近吊销的在前，统一小写，至多 256 个', () => {
    expect(revokedNodeIdsFrom(certs)).toEqual([C, A]);
    const many = Array.from({ length: 300 }, (_, i) => ({
      nodeId: i.toString(16).padStart(32, '0'),
      revokedLogSeq: i + 1,
    }));
    const ids = revokedNodeIdsFrom(many);
    expect(ids).toHaveLength(256);
    expect(ids[0]).toBe((299).toString(16).padStart(32, '0'));
  });

  test('请求体不带 force_rotate 时不附吊销列表', () => {
    expect(enrollPassThrough({ password: 'pw' }, certs)).toEqual({ password: 'pw' });
    expect(enrollPassThrough({ force_rotate: true }, certs)).toEqual({
      forceRotate: true,
      revokedNodeIds: [C, A],
    });
  });

  test('发给中继的 enroll 请求只在 force_rotate 时带 revoked_node_ids', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ tenant_id: 'f'.repeat(32), token_unchanged: true });
    }) as unknown as typeof fetch;
    const base = {
      rootPublicKey: new Uint8Array(32),
      rootEpoch: 0,
      proof: { bytes: new Uint8Array(8), sig: new Uint8Array(64) },
      fetchImpl,
      dial: { roles: { relay: false }, relayPublicUrl: null, gatewayPort: 0 },
    };
    await callRelayEnroll('https://relay.example.com', {
      ...base,
      forceRotate: true,
      revokedNodeIds: [A],
    });
    await callRelayEnroll('https://relay.example.com', { ...base, revokedNodeIds: [A] });
    expect(bodies[0]?.force_rotate).toBe(true);
    expect(bodies[0]?.revoked_node_ids).toEqual([A]);
    expect(bodies[1]?.revoked_node_ids).toBeUndefined();
  });
});
