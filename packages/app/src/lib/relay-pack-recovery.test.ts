import './test-master-key';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { RELAY_LOG_KEY_EPOCH } from '../../../../apps/gateway/src/auth/mesh-relay-store';
import { RelayKeyLogSync } from '../../../../apps/gateway/src/mesh/relay-key-log-sync';
import {
  NODE_PASSWORD,
  RELAY_TEST_PUBLIC_URL,
  type RelayMeshHarness,
  bootRelayMeshHarness,
  waitUntil,
} from '../../../../apps/gateway/src/relay/integration/relay-mesh-harness';
import { sealRelayKeyLogRecord } from '../../../shared/src/relay';
import { runRelayPackUpload, runRelayReauth } from '../commands/relay';
import { parseArgs } from './args';
import type { FetchLike } from './fetch-like';
import { createAuthContextFromDb } from './local-auth';

let harness: RelayMeshHarness | undefined;
let suspended: ReturnType<typeof spyOn<RelayKeyLogSync, 'appendAndAck'>> | undefined;

afterEach(async () => {
  suspended?.mockRestore();
  suspended = undefined;
  await harness?.stop();
  harness = undefined;
});

async function fixture() {
  const h = await bootRelayMeshHarness({ password: 'first-pass' });
  harness = h;
  const tenant = await h.createTenant('pack-recovery');
  await tenant.enroll({ password: 'first-pass' });
  const node = tenant.owner;
  const auth = await createAuthContextFromDb(node.db);
  suspended = spyOn(RelayKeyLogSync.prototype, 'appendAndAck').mockResolvedValue({
    ok: false,
    error: 'offline',
  });
  const calls: Array<{ path: string; method: string }> = [];
  const logs: string[] = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    calls.push({ path, method: init?.method ?? 'GET' });
    return url.hostname === new URL(RELAY_TEST_PUBLIC_URL).hostname
      ? h.relay.fetch(path, init)
      : node.call(path, init);
  };
  const io = {
    auth,
    fetcher,
    password: NODE_PASSWORD,
    relayPassword: 'second-pass',
    env: { GATEWAY_PORT: '19993' },
    log: (line: string) => logs.push(line),
    pollIntervalMs: 10,
    pollTimeoutMs: 8_000,
  };
  async function appendPending() {
    const prepared = await node.call('/api/mesh/relay/resend-token/prepare', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    await tenant.submitPrepared(prepared, 'set-relays');
    expect(h.relay.runtime.keyLog.head(tenant.tenantId())).toBeLessThan(
      auth.keyLogStore.head(tenant.userId)!.seq
    );
  }
  function expectPackWritten() {
    const remote = h.relay.runtime.tenants.get(tenant.tenantId());
    expect(remote?.sealedPack?.byteLength).toBeGreaterThan(0);
    expect(remote?.keyLogHeadSeq).toBe(auth.keyLogStore.head(tenant.userId)!.seq);
    expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/keylog'))).toBe(
      true
    );
  }
  return { h, tenant, auth, io, calls, logs, appendPending, expectPackWritten };
}

test('reauth after kick publishes pending records before writing the sealed pack', async () => {
  const f = await fixture();
  const kicked = await f.h.relay.adminFetch('/api/relay/password', {
    method: 'POST',
    body: JSON.stringify({ password: 'second-pass', mode: 'kick', force: true }),
  });
  expect(kicked.status).toBe(200);
  await waitUntil(() => f.tenant.owner.relayStore.listRelayRows()[0]?.kicked === true);
  let observedAhead = false;
  const fetcher: FetchLike = (input, init) => {
    if (String(input).includes('/keylog?from_seq=')) {
      observedAhead ||=
        f.h.relay.runtime.keyLog.head(f.tenant.tenantId()) <
        f.auth.keyLogStore.head(f.tenant.userId)!.seq;
    }
    return f.io.fetcher(input, init);
  };
  const result = await runRelayReauth(
    parseArgs(['relay', 'reauth', RELAY_TEST_PUBLIC_URL]),
    RELAY_TEST_PUBLIC_URL,
    { ...f.io, fetcher }
  );
  expect(result.online).toBe(true);
  expect(observedAhead).toBe(true);
  f.expectPackWritten();
  expect(f.logs.at(-1)).toContain('attached to relay');
}, 20_000);

test('pack upload publishes pending records and confirms a competing publisher by content', async () => {
  const f = await fixture();
  await f.appendPending();
  let raced = false;
  const fetcher: FetchLike = async (input, init) => {
    if (!raced && String(input).endsWith('/keylog') && init?.method === 'POST') {
      raced = true;
      expect((await f.io.fetcher(input, init)).status).toBe(200);
    }
    return f.io.fetcher(input, init);
  };
  await runRelayPackUpload(parseArgs(['relay', 'pack', 'upload']), { ...f.io, fetcher });
  expect(raced).toBe(true);
  f.expectPackWritten();
  expect(f.logs).toEqual(['Current sealed relay packs uploaded.']);
}, 15_000);

test('HEAD_AHEAD after pre-sync is retried once after another sync', async () => {
  const f = await fixture();
  await f.appendPending();
  let uploads = 0;
  const fetcher: FetchLike = (input, init) => {
    if (String(input).endsWith('/pack') && uploads++ === 0) {
      return Promise.resolve(Response.json({ code: 'RELAY_PACK_HEAD_AHEAD' }, { status: 409 }));
    }
    return f.io.fetcher(input, init);
  };
  await runRelayPackUpload(parseArgs(['relay', 'pack', 'upload']), { ...f.io, fetcher });
  expect(uploads).toBe(2);
  f.expectPackWritten();
}, 15_000);

test('a relay record with the same sequence and different signature cannot confirm synchronization', async () => {
  const f = await fixture();
  const head = f.auth.keyLogStore.head(f.tenant.userId)!;
  const record = f.auth.keyLogStore.getAtSeq(f.tenant.userId, Number(head.seq))!;
  const sig = record.sig.slice();
  sig[0] = (sig[0] ?? 0) ^ 1;
  const key = await f.tenant.owner.relayStore.getSecret('log', RELAY_LOG_KEY_EPOCH);
  const blob = await sealRelayKeyLogRecord(key!, { bytes: record.bytes, sig });
  const fetcher: FetchLike = (input, init) => {
    if (String(input).includes('/keylog?from_seq=')) {
      return Promise.resolve(
        Response.json({ key_log: [{ seq: Number(head.seq), blob }], has_more: false })
      );
    }
    return f.io.fetcher(input, init);
  };
  await expect(
    runRelayPackUpload(parseArgs(['relay', 'pack', 'upload']), { ...f.io, fetcher })
  ).rejects.toThrow(`relay key log fork at seq ${head.seq}`);
  expect(f.calls.some((call) => call.path.endsWith('/pack'))).toBe(false);
  expect(f.logs).toEqual([]);
}, 15_000);

test.each(['publish', 'pack'] as const)(
  'unrecoverable %s failure gives the exact install-specific next command',
  async (stage) => {
    const f = await fixture();
    await f.appendPending();
    let uploads = 0;
    const fetcher: FetchLike = (input, init) => {
      if (String(input).endsWith('/pack')) uploads += 1;
      if (
        String(input).endsWith(stage === 'publish' ? '/keylog' : '/pack') &&
        init?.method === 'POST'
      ) {
        return Promise.resolve(Response.json({ code: 'RELAY_PACK_HEAD_AHEAD' }, { status: 409 }));
      }
      return f.io.fetcher(input, init);
    };
    await expect(
      runRelayPackUpload(
        parseArgs([
          'relay',
          'pack',
          'upload',
          '--install-dir',
          '/tmp/recovery node',
          '--service-name',
          'recovery',
        ]),
        { ...f.io, fetcher }
      )
    ).rejects.toThrow(
      "Relay pack upload failed: RELAY_PACK_HEAD_AHEAD (HTTP 409) Retry: vibeterm relay pack upload --install-dir '/tmp/recovery node' --service-name 'recovery'"
    );
    expect(uploads).toBe(stage === 'publish' ? 0 : 2);
    expect(f.logs).toEqual([]);
  },
  15_000
);
