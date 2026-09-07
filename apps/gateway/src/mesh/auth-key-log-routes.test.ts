import { describe, expect, test } from 'bun:test';
import {
  buildKeyLogRecord,
  computeRecordHash,
  decodeKeyLogRecord,
  encodeBase64url,
  encodeKeyLogRecord,
  signKeyLogRecordWithRoot,
} from '@vibeterm/shared/auth';
import { generateTenantKey } from '@vibeterm/shared/relay';
import { ChallengeStore } from '../auth/challenge-store';
import { KeyLogStore } from '../auth/key-log-store';
import { ensureNodeIdentity } from '../auth/node-identity-service';
import { NodeIdentityStore } from '../auth/node-identity-store';
import { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import { AuthKeyLogRoutes } from './auth-key-log-routes';
import type { AuthKeyLogPublisher } from './auth-routes';
import { buildSetRelaysPayload, listRelayNodeKeys } from './relay-payloads';

async function boot(publisher: AuthKeyLogPublisher) {
  const { db, close } = createMigratedAuthDb();
  const userStore = new UserStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const service = new UserKeyService({
    db,
    userStore,
    keyLogStore: new KeyLogStore(db),
    nodeSessionStore,
  });
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const user = await service.bootstrapUserWithSelfAdmit({
    username: 'relay-ack',
    password: 'relay-ack-password',
    identity,
  });
  userStore.createNode({
    id: identity.nodeIdHex,
    userId: user.userId,
    name: 'self',
    version: '2.0.1',
    now: 1,
  });
  const payload = await buildSetRelaysPayload({
    relays: [
      {
        url: 'https://relay.example',
        tenantId: 'ab'.repeat(16),
        token: generateTenantKey(),
        priority: 0,
      },
    ],
    logKey: generateTenantKey(),
    metaKey: generateTenantKey(),
    metaEpoch: 1,
    nodes: listRelayNodeKeys(userStore, user.userId),
  });
  const routes = new AuthKeyLogRoutes(
    {
      roles: { hub: false, node: true, relay: false },
      nodeId: identity.nodeIdHex,
      nodePk: identity.edPublicKey,
      userStore,
      keyLogService: service,
      challengeStore: new ChallengeStore(),
      nodeSessionStore,
      publisher,
    },
    { invalidateAuthModeCache: () => {}, getForwardWriterWrite: () => null }
  );
  const sign = () => {
    const state = service.currentState(user.userId);
    const bytes = encodeKeyLogRecord(
      buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: user.userId,
        type: 'set-relays',
        payload,
        signer: 'root',
        credential_id: null,
      })
    );
    return { bytes, sig: signKeyLogRecordWithRoot(user.rootKey, bytes) };
  };
  const post = (record = sign()) =>
    routes.handleKeyLog(
      new Request('http://localhost/api/auth/keylog?hub=sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bytes: encodeBase64url(record.bytes),
          sig: encodeBase64url(record.sig),
        }),
      }),
      user.userId
    );
  const head = () => service.currentState(user.userId).head.seq;
  return { close, sign, post, head };
}

describe('relay append acknowledgement', () => {
  for (const error of ['timeout', 'SEQ_MISMATCH']) {
    test(`lost ACK ${error} is confirmed only by identical remote bytes and signature`, async () => {
      let remote: { bytes: Uint8Array; sig: Uint8Array } | null = null;
      let readable = false;
      const b = await boot({
        publish: () => {},
        publishAndAck: async (record) => {
          remote ??= record;
          return { ok: false, error };
        },
        queryKeyLogAt: async (seq) => {
          expect(seq).toBe(decodeKeyLogRecord(remote!.bytes).seq);
          return readable ? remote : null;
        },
      });
      try {
        await b.post();
        const record = b.sign();
        expect(await (await b.post(record)).json()).toMatchObject({ relayAck: false });
        const head = b.head();
        readable = true;
        expect(await (await b.post(record)).json()).toMatchObject({ relayAck: true });
        expect(b.head()).toBe(head);
      } finally {
        b.close();
      }
    });
  }

  for (const changed of ['bytes', 'sig', 'unavailable'] as const) {
    test(`relay retry rejects ${changed} remote record even if head hash matches`, async () => {
      let sent: { bytes: Uint8Array; sig: Uint8Array };
      const b = await boot({
        publish: () => {},
        publishAndAck: async (record) => {
          sent = record;
          return { ok: false, error: 'SEQ_MISMATCH' };
        },
        queryKeyLogAt: async () => {
          if (changed === 'unavailable') throw new Error('timeout');
          const remote = { bytes: sent.bytes.slice(), sig: sent.sig.slice() };
          remote[changed][0] ^= 1;
          return remote;
        },
        queryHubHead: async () => ({
          seq: decodeKeyLogRecord(sent.bytes).seq,
          hash: computeRecordHash(sent.bytes, sent.sig),
        }),
      });
      try {
        await b.post();
        expect(await (await b.post()).json()).toMatchObject({
          relayAck: false,
          relayError: 'SEQ_MISMATCH',
        });
      } finally {
        b.close();
      }
    });
  }

  test('first enrollment reports no relay publication and does not publish to the old hub', async () => {
    let calls = 0;
    const b = await boot({
      publish: () => {
        calls += 1;
      },
      publishAndAck: async () => {
        calls += 1;
        return { ok: true, seq: 0n };
      },
    });
    try {
      const before = b.head();
      const res = await b.post();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        localApply: true,
        relayAck: false,
        relayError: 'not_published',
      });
      expect(b.head()).toBe(before + 1n);
      expect(calls).toBe(0);
    } finally {
      b.close();
    }
  });

  test('reports relay ACK only after the record was applied locally', async () => {
    let observedHead = 0n;
    const b = await boot({
      publish: () => {
        throw new Error('unexpected best-effort publication');
      },
      publishAndAck: async () => {
        observedHead = b.head();
        return { ok: true, seq: observedHead };
      },
    });
    try {
      await b.post();
      const before = b.head();
      const res = await b.post();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, hubAck: true, localApply: true, relayAck: true });
      expect(body).not.toHaveProperty('relayError');
      expect(observedHead).toBe(before + 1n);
    } finally {
      b.close();
    }
  });

  for (const error of ['offline', 'timeout', 'SEQ_MISMATCH']) {
    test(`relay ${error} is reported without rolling back local append`, async () => {
      const b = await boot({
        publish: () => {},
        publishAndAck: async () => ({ ok: false, error }),
      });
      try {
        await b.post();
        const before = b.head();
        const res = await b.post();
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          ok: true,
          localApply: true,
          relayAck: false,
          relayError: error,
        });
        expect(b.head()).toBe(before + 1n);
      } finally {
        b.close();
      }
    });
  }

  test('identical local replay retries failed publication and reports the new acknowledgement', async () => {
    let attempts = 0;
    const b = await boot({
      publish: () => {},
      publishAndAck: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('uplink is not online');
        return { ok: true, seq: 0n };
      },
    });
    try {
      await b.post();
      const record = b.sign();
      expect(await (await b.post(record)).json()).toMatchObject({
        relayAck: false,
        relayError: 'uplink is not online',
      });
      const head = b.head();
      expect(await (await b.post(record)).json()).toMatchObject({ ok: true, relayAck: true });
      expect(b.head()).toBe(head);
      expect(attempts).toBe(2);
    } finally {
      b.close();
    }
  });

  test('publisher without acknowledgement support cannot report relay success', async () => {
    let published = 0;
    const b = await boot({
      publish: () => {
        published += 1;
      },
    });
    try {
      await b.post();
      expect(await (await b.post()).json()).toMatchObject({
        ok: true,
        relayAck: false,
        relayError: 'unavailable',
      });
      expect(published).toBe(1);
    } finally {
      b.close();
    }
  });
});
