import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64url } from '@vibeterm/shared/auth';
import { canonicalHubUrl } from '@vibeterm/shared/auth';
import { signRelayEnrollProof } from '@vibeterm/shared/relay';
import {
  RELAY_TEST_PUBLIC_URL,
  RELAY_TEST_PUBLIC_URL_2,
  type RelayMeshHarness,
  bootRelayMeshHarness,
  waitUntil,
  waitUntilAsync,
} from './relay-mesh-harness';

let harness: RelayMeshHarness | null = null;

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

type RelayStatus = {
  multiAttach: boolean;
  nodesViaRelay: number;
  relays: Array<{
    url: string;
    role: 'primary' | 'secondary' | null;
    online: boolean;
    attached: boolean;
  }>;
};

async function enrollAt(
  tenant: Awaited<ReturnType<RelayMeshHarness['createTenant']>>,
  url: string,
  password: string
): Promise<void> {
  const material = await tenant.owner.json<{ relayHost: string; ts: number }>(
    '/api/mesh/relay/enroll/proof-material',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }
  );
  const proof = signRelayEnrollProof(tenant.rootKey, {
    relayHost: material.relayHost,
    ts: material.ts,
  });
  const res = await tenant.owner.call('/api/mesh/relay/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url,
      password,
      proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
    }),
  });
  if (res.status !== 200) throw new Error(`enroll ${url} → ${res.status}: ${await res.text()}`);
  await tenant.submitPrepared(res, 'set-relays');
}

describe('multi-relay attach', () => {
  test('节点同时挂两台中继时能看见只在第二台上的对端，openRelayVia 可达', async () => {
    const password = 'relay-pass';
    harness = await bootRelayMeshHarness({ password });
    await harness.addRelay(RELAY_TEST_PUBLIC_URL_2, { password });
    const tenant = await harness.createTenant('alpha', { password });
    await tenant.enroll({ password });
    await enrollAt(tenant, RELAY_TEST_PUBLIC_URL_2, password);

    const owner = tenant.owner;
    await waitUntilAsync(async () => {
      const status = await owner.json<RelayStatus>('/api/mesh/relay/status');
      return status.multiAttach && status.relays.filter((row) => row.online).length >= 2;
    }, 12_000);

    const b = await tenant.joinNode('alpha-b');
    await waitUntil(() => owner.userStore.getPeer(b.nodeId)?.name === 'alpha-b', 8_000);

    const firstUrl = b.relayStore.listRelayRows()[0]?.url ?? canonicalHubUrl(RELAY_TEST_PUBLIC_URL);
    const secondUrl =
      b.relayStore.listRelayRows().find((row) => row.url !== firstUrl)?.url ??
      canonicalHubUrl(RELAY_TEST_PUBLIC_URL_2);
    b.relayStore.markKicked(firstUrl, true, 'kicked');
    await b.mesh.reconfigureUplink();
    await waitUntil(() => b.mesh.uplink.state === 'online', 8_000);

    await waitUntil(() => {
      const urls = owner.mesh.relayPresence?.relaysFor(b.nodeId) ?? [];
      return urls.some((url) => url === secondUrl || url.includes('relay-b'));
    }, 12_000);

    const stream = await owner.mesh.relayOpener?.openRelayVia(secondUrl, b.nodeId);
    expect(stream).toBeTruthy();
    stream?.reset('test-done');
  });
});
