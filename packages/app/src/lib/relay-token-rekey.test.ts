import './test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import {
  buildSetRelaysPayload,
  listRelayNodeKeys,
} from '../../../../apps/gateway/src/mesh/relay-payloads';
import { RelaySecrets } from '../../../../apps/gateway/src/mesh/relay-secrets';
import {
  decodeKeyLogRecord,
  encodeBase64url,
  encodeMetaKeyPayload,
} from '../../../shared/src/auth';
import { RELAY_TOKEN_HEADER } from '../../../shared/src/http/mesh-headers';
import { openRelayKeyLogRecord, sealRelayKeyLogRecord } from '../../../shared/src/relay';
import type { FetchLike } from './fetch-like';
import { type LocalAuthContext, openLocalAuth } from './local-auth';
import type { JoinLogPhase, JoinPackPhase } from './relay-password-join-flow';
import { assertRekeyAccount, rekeyRelayToken } from './relay-token-rekey';

const RELAY_URL = 'https://relay.example';
const TENANT_ID = 'ab'.repeat(16);
const OLD_TOKEN = new Uint8Array(32).fill(1);
const PACK_TOKEN = new Uint8Array(32).fill(2);
const LOG_KEY = new Uint8Array(32).fill(3);
const handles: LocalAuthContext[] = [];

afterEach(() => {
  for (const auth of handles.splice(0)) auth.close();
});

async function fixture() {
  const auth = await openLocalAuth({ memory: true });
  handles.push(auth);
  const identity = await ensureNodeIdentity(auth.identityStore);
  const user = await auth.userKeys.bootstrapUserWithSelfAdmit({
    username: 'rekey-member',
    password: 'rekey-password',
    identity,
  });
  const secrets = new RelaySecrets({ db: auth.db, identity, userIdOf: () => user.userId });
  const metaKey = new Uint8Array(32).fill(4);
  async function appendToken(token: Uint8Array) {
    const applied = await auth.userKeys.signAndApply(user.userId, user.rootKey, {
      type: 'set-relays',
      payload: await buildSetRelaysPayload({
        relays: [{ url: RELAY_URL, tenantId: TENANT_ID, token, priority: 0 }],
        logKey: LOG_KEY,
        metaKey,
        metaEpoch: 1,
        nodes: listRelayNodeKeys(auth.userStore, user.userId),
      }),
    });
    if (!applied.ok) throw new Error(applied.error);
  }
  await appendToken(OLD_TOKEN);
  await secrets.reconcile();
  function readLog(): JoinLogPhase {
    return {
      records: auth.keyLogStore.list(user.userId).map(({ bytes, sig }) => ({ bytes, sig })),
      genesisUid: user.userId,
      state: auth.userKeys.currentState(user.userId),
    };
  }
  const log = readLog();
  const storedUser = auth.userStore.getById(user.userId);
  if (!storedUser) throw new Error('missing fixture user');
  const pack: JoinPackPhase = {
    rootKey: user.rootKey,
    rootEpoch: user.rootEpoch,
    packKdf: kdfParamsFromJson(storedUser.kdfParamsJson),
    now: Date.now(),
    pack: {
      v: 1,
      token: PACK_TOKEN,
      log_key: LOG_KEY,
      head_seq: log.state.head.seq,
      head_hash: log.state.head.hash,
      issued_at: BigInt(Date.now()),
    },
  };
  function run(fetcher: FetchLike, currentLog = log) {
    return rekeyRelayToken({
      auth,
      userId: user.userId,
      transport: { relayUrl: RELAY_URL, tenantId: TENANT_ID, fetcher },
      pack,
      log: currentLog,
      now: pack.now,
    });
  }
  return { auth, user, secrets, log, pack, readLog, appendToken, run };
}

describe('relay token rekey', () => {
  test('refuses a different account before contacting the relay or changing local state', async () => {
    const f = await fixture();
    let called = false;
    await expect(
      f.run(
        async () => {
          called = true;
          return Response.json({});
        },
        { ...f.log, genesisUid: 'different-account' }
      )
    ).rejects.toMatchObject({ code: 'local_user_exists' });
    expect(called).toBe(false);
    expect(f.readLog().records).toEqual(f.log.records);
    expect((await f.secrets.store.getRelay(RELAY_URL))?.token).toEqual(OLD_TOKEN);
  });

  test('rejects truncated and forked relay logs at the local head', async () => {
    const f = await fixture();
    expect(() =>
      assertRekeyAccount(f.auth, f.user.userId, { ...f.log, records: f.log.records.slice(0, -1) })
    ).toThrow(/not a prefix/);
    const records = f.log.records.map((record) => ({ ...record }));
    const last = records[records.length - 1];
    if (!last) throw new Error('missing head');
    last.sig = new Uint8Array(last.sig);
    last.sig[0] ^= 1;
    expect(() => assertRekeyAccount(f.auth, f.user.userId, { ...f.log, records })).toThrow(
      /not a prefix/
    );
    expect(f.readLog().records).toEqual(f.log.records);
  });

  test('uses the refreshed pack token and commits only after the relay acknowledges', async () => {
    const f = await fixture();
    let calls = 0;
    const result = await f.run(async (url, init) => {
      calls++;
      expect(String(url)).toBe(`${RELAY_URL}/api/relay/tenants/${TENANT_ID}/keylog`);
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers as HeadersInit).get(RELAY_TOKEN_HEADER.name)).toBe(
        encodeBase64url(PACK_TOKEN)
      );
      const body = JSON.parse(String(init?.body));
      const record = await openRelayKeyLogRecord(LOG_KEY, body.blob);
      expect(decodeKeyLogRecord(record.bytes).type).toBe('set-relays');
      expect(body.seq).toBe(f.log.records.length + 1);
      expect(f.readLog().records).toEqual(f.log.records);
      expect((await f.secrets.store.getRelay(RELAY_URL))?.token).toEqual(OLD_TOKEN);
      return Response.json({ ok: true });
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ userId: f.user.userId, publishedSetRelays: true });
    expect(f.readLog().records).toHaveLength(f.log.records.length + 1);
    expect((await f.secrets.store.getRelay(RELAY_URL))?.token).toEqual(PACK_TOKEN);
    await f.secrets.reconcile();
    expect((await f.secrets.store.getRelay(RELAY_URL))?.token).toEqual(PACK_TOKEN);
  });

  test('failed relay append leaves the local key log and token unchanged', async () => {
    const f = await fixture();
    await expect(
      f.run(async () => Response.json({ error: { code: 'unavailable' } }, { status: 503 }))
    ).rejects.toMatchObject({
      code: 'join_failed',
      message: expect.stringContaining('append failed'),
    });
    expect(f.readLog().records).toEqual(f.log.records);
    expect((await f.secrets.store.getRelay(RELAY_URL))?.token).toEqual(OLD_TOKEN);
  });

  test('a set-relays newer than the pack wins without publishing an obsolete pack token', async () => {
    const f = await fixture();
    const newestToken = new Uint8Array(32).fill(5);
    await f.appendToken(newestToken);
    let calls = 0;
    const result = await f.run(async () => {
      calls++;
      throw new Error('unexpected relay append');
    }, f.readLog());
    expect(calls).toBe(0);
    expect(result.publishedSetRelays).toBe(false);
    expect((await f.secrets.store.getRelay(RELAY_URL))?.token).toEqual(newestToken);
  });

  test('a changed projection at the pack head still needs the newer pack token', async () => {
    const f = await fixture();
    await f.appendToken(new Uint8Array(32).fill(6));
    const log = f.readLog();
    f.pack.pack.head_seq = log.state.head.seq;
    f.pack.pack.head_hash = log.state.head.hash;
    const result = await f.run(async () => Response.json({ ok: true }), log);
    expect(result.publishedSetRelays).toBe(true);
    expect((await f.secrets.store.getRelay(RELAY_URL))?.token).toEqual(PACK_TOKEN);
  });

  test('missing current meta key refuses recovery without touching the relay or local token', async () => {
    const f = await fixture();
    const applied = await f.auth.userKeys.signAndApply(f.user.userId, f.user.rootKey, {
      type: 'meta-key',
      payload: encodeMetaKeyPayload({ epoch: 2, entries: [] }),
    });
    expect(applied.ok).toBe(true);
    const log = f.readLog();
    let calls = 0;
    await expect(
      f.run(async () => {
        calls++;
        return Response.json({});
      }, log)
    ).rejects.toMatchObject({ code: 'relay_key_missing' });
    expect(calls).toBe(0);
    expect(f.readLog().records).toEqual(log.records);
    expect((await f.secrets.store.getRelay(RELAY_URL))?.token).toEqual(OLD_TOKEN);
  });

  test('repeated sequence conflicts are bounded and do not append locally', async () => {
    const f = await fixture();
    const keyLog = await Promise.all(
      f.log.records.map(async (record, index) => ({
        seq: index + 1,
        blob: await sealRelayKeyLogRecord(LOG_KEY, record),
      }))
    );
    let appends = 0;
    let downloads = 0;
    await expect(
      f.run(async (_url, init) => {
        if (init?.method === 'POST') {
          appends++;
          return Response.json({ error: { code: 'SEQ_MISMATCH' } }, { status: 409 });
        }
        downloads++;
        return Response.json({ key_log: keyLog, has_more: false });
      })
    ).rejects.toMatchObject({
      code: 'join_failed',
      message: expect.stringContaining('kept moving'),
    });
    expect(appends).toBe(3);
    expect(downloads).toBe(3);
    expect(f.readLog().records).toEqual(f.log.records);
    expect((await f.secrets.store.getRelay(RELAY_URL))?.token).toEqual(OLD_TOKEN);
  });
});
