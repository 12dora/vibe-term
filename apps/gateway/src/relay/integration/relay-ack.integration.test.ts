import { expect, test } from 'bun:test';
import {
  buildKeyLogRecord,
  decodeKeyLogRecord,
  encodeBase64url,
  encodeKeyLogRecord,
  signKeyLogRecordWithRoot,
} from '@vibeterm/shared/auth';
import { bootRelayMeshHarness, waitRelayKeyLogSynced } from './relay-mesh-harness';

test('lost relay ACK retry confirms the persisted encrypted record after SEQ_MISMATCH', async () => {
  const h = await bootRelayMeshHarness();
  try {
    const tenant = await h.createTenant('lost-relay-ack');
    await tenant.enroll();
    await waitRelayKeyLogSynced(h, tenant);
    const node = tenant.owner;
    const state = node.keys.currentState(tenant.userId);
    const rows = await node.keys.list(tenant.userId, 1n);
    const previous = rows
      .reverse()
      .find((row) => decodeKeyLogRecord(row.bytes).type === 'set-relays');
    if (!previous) throw new Error('missing set-relays');
    const bytes = encodeKeyLogRecord(
      buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: tenant.userId,
        type: 'set-relays',
        payload: decodeKeyLogRecord(previous.bytes).payload,
        signer: 'root',
        credential_id: null,
      })
    );
    const record = { bytes, sig: signKeyLogRecordWithRoot(tenant.rootKey, bytes) };
    const client = node.relayClient()!;
    const append = client.appendAndAck.bind(client);
    const query = client.queryKeyLogAt.bind(client);
    client.appendAndAck = async (...args) => {
      const ack = await append(...args);
      return ack.ok ? { ok: false, error: 'timeout' } : ack;
    };
    client.queryKeyLogAt = async () => null;
    const post = () =>
      node.call('/api/auth/keylog?hub=sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bytes: encodeBase64url(bytes), sig: encodeBase64url(record.sig) }),
      });
    expect(await (await post()).json()).toMatchObject({ relayAck: false, relayError: 'timeout' });
    const head = node.keys.currentState(tenant.userId).head;
    expect(h.relay.runtime.tenants.get(tenant.tenantId())?.keyLogHeadSeq).toBe(head.seq);
    client.queryKeyLogAt = query;
    expect(await (await post()).json()).toMatchObject({ relayAck: true });
    expect(node.keys.currentState(tenant.userId).head).toEqual(head);
  } finally {
    await h.stop();
  }
}, 15_000);
