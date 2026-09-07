import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  MeshRelayStore,
  RELAY_LOG_KEY_EPOCH,
} from '../../../../apps/gateway/src/auth/mesh-relay-store';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import {
  DOMAIN_AUTHORIZATION,
  decodeAdmitNodePayload,
  decodeAuthorization,
  decodeBase64url,
  decodeKeyLogRecord,
  encodeAuthorization,
  encodeBase64url,
  randomBytes,
  verifyEd25519,
} from '../../../shared/src/auth';
import {
  decodeRelayEnrollProof,
  openRelayPack,
  verifyRelayEnrollProof,
} from '../../../shared/src/relay';
import { parseArgs } from '../lib/args';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { deriveRootKey } from '../lib/password';
import { RELAY_RECORD_MAX_ATTEMPTS, RELAY_ROOT_ROTATED } from '../lib/relay-session';
import { runHubUserAdd } from './hub';
import {
  formatRelayStatusLines,
  parseRelayHealth,
  runRelayEnroll,
  runRelayLeave,
  runRelayList,
  runRelayPackUpload,
  runRelayReauth,
  runRelayResendToken,
} from './relay';
import type { RelayIo } from './relay-shared';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const PASSWORD = 'relay-pass-word';
const RELAY_URL = 'https://relay.example';
const RELAY_HOST = 'relay.example';
const SET_RELAYS_PAYLOAD = new Uint8Array([1, 2, 3, 4, 5]);
const handles: LocalAuthContext[] = [];

afterEach(() => {
  for (const ctx of handles.splice(0)) ctx.close();
});

async function openAuth(): Promise<LocalAuthContext> {
  const auth = await openLocalAuth({
    memory: true,
    migrationsFolder: MIGRATIONS,
    env: {
      VIBETERM_MASTER_KEY: process.env.VIBETERM_MASTER_KEY || '',
      VIBETERM_ROLES: 'node',
      GATEWAY_PORT: '19993',
    },
  });
  handles.push(auth);
  await runHubUserAdd(parseArgs(['hub', 'user', 'add', 'ivy']), 'ivy', {
    auth,
    password: PASSWORD,
    log: () => undefined,
  });
  const store = new MeshRelayStore(auth.db);
  await store.replaceRelays(
    [{ url: RELAY_URL, tenantId: 'd'.repeat(32), token: randomBytes(32), priority: 0 }],
    Date.now()
  );
  await store.putSecret('log', RELAY_LOG_KEY_EPOCH, randomBytes(32), Date.now());
  return auth;
}

type Call = { path: string; method: string; body: Record<string, unknown> | undefined };

type FakeOptions = {
  health?: Record<string, unknown>;
  pack?: () => Response;
  status?: Record<string, unknown>[];
  rejectUnauthedStatus?: boolean;
  enroll?: () => Response;
  leave?: Record<string, unknown>;
  resendToken?: Record<string, unknown>;
  /** 依次作用于每一次 `POST /api/auth/keylog?hub=sync`；用完回落到成功。 */
  appends?: Array<() => Response>;
  /** 依次作用于每一次 `GET /api/auth/keylog/head` 的 rootEpoch。 */
  headEpochs?: number[];
  readmitPrepare?: Record<string, unknown>;
};

function fakeGateway(auth: LocalAuthContext, options: FakeOptions = {}) {
  const calls: Call[] = [];
  const user = auth.userStore.getByUsername('ivy');
  if (!user) throw new Error('missing ivy');
  const statuses = options.status ?? [];
  let statusIndex = 0;
  let appendIndex = 0;
  let headIndex = 0;
  let headSeq = user.keyLogHeadSeq;
  let headHash = encodeBase64url(user.keyLogHeadHash);

  const json = (payload: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    });

  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ path, method: init?.method ?? 'GET', body });
    if (url.origin === RELAY_URL || url.origin.startsWith(`${RELAY_URL}:`)) {
      if (url.pathname.endsWith('/pack')) return options.pack?.() ?? json({ ok: true });
      return json(options.health ?? { ok: true, version: '1.1.23', hasPassword: true });
    }
    switch (path) {
      case '/api/auth/mode':
        return json({
          mode: 'root',
          nodeId: 'self',
          uid: user.id,
          username: 'ivy',
          totpEnabled: false,
          passkeySecondFactor: false,
        });
      case '/api/auth/challenge':
        return json({
          challenge_id: 'challenge-1',
          nonce: encodeBase64url(randomBytes(32)),
          nodePk: encodeBase64url(randomBytes(32)),
        });
      case '/api/auth/login':
        return json(
          { expires_at: Date.now() + 60_000 },
          {
            headers: { 'content-type': 'application/json', 'x-tmex-set-session': 'sid-1' },
          }
        );
      case '/api/mesh/relay/enroll/proof-material':
        return json({
          url: RELAY_URL,
          relayHost: RELAY_HOST,
          ts: 1_760_000_000_000,
          rootEpoch: 0,
        });
      case '/api/mesh/relay/enroll':
        return (
          options.enroll?.() ??
          json({
            tenantId: 'd'.repeat(32),
            token: encodeBase64url(randomBytes(32)),
            passwordEpoch: 1,
            metaEpoch: 1,
            payload: encodeBase64url(SET_RELAYS_PAYLOAD),
            payloadHash: encodeBase64url(randomBytes(32)),
          })
        );
      case '/api/mesh/relay/readmit/prepare':
        return json(options.readmitPrepare ?? { rootEpoch: user.rootEpoch, entries: [] });
      case '/api/mesh/relay/leave/prepare':
        return json(options.leave ?? { payload: encodeBase64url(SET_RELAYS_PAYLOAD) });
      case '/api/mesh/relay/resend-token/prepare':
        return json(
          options.resendToken ?? { nodes: 3, payload: encodeBase64url(SET_RELAYS_PAYLOAD) }
        );
      case '/api/auth/keylog/head': {
        const epochs = options.headEpochs;
        const rootEpoch = epochs?.[Math.min(headIndex, epochs.length - 1)] ?? user.rootEpoch;
        headIndex += 1;
        return json({
          seq: headSeq,
          hash: headHash,
          rootEpoch,
          uid: user.id,
        });
      }
      case '/api/auth/keylog?hub=sync': {
        const make = options.appends?.[appendIndex];
        appendIndex += 1;
        if (make) return make();
        headSeq += 1;
        headHash = encodeBase64url(randomBytes(32));
        return json({ seq: headSeq, hash: headHash, relayAck: true });
      }
      case '/api/mesh/relay/status': {
        const headerBag = init?.headers as Headers | Record<string, string> | undefined;
        const cookie =
          headerBag instanceof Headers
            ? headerBag.get('cookie')
            : typeof headerBag?.cookie === 'string'
              ? headerBag.cookie
              : '';
        if (options.rejectUnauthedStatus && !cookie) {
          return json({ code: 'UNAUTHORIZED' }, { status: 401 });
        }
        const next = statuses[Math.min(statusIndex, statuses.length - 1)] ?? {
          mode: 'none',
          relays: [],
        };
        statusIndex += 1;
        return json(next);
      }
      default:
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
  }) as unknown as typeof fetch;

  return { calls, fetcher, user };
}

function io(auth: LocalAuthContext, fetcher: typeof fetch, logs: string[]): RelayIo {
  return {
    auth,
    fetcher,
    env: { GATEWAY_PORT: '19993' },
    password: PASSWORD,
    relayPassword: 'relay-site-password',
    log: (line) => logs.push(line),
    pollIntervalMs: 1,
    pollTimeoutMs: 200,
  };
}

function sampleAuthorization(uid: string, signer: 'root' | 'passkey'): Uint8Array {
  return encodeAuthorization({
    domain: DOMAIN_AUTHORIZATION,
    uid,
    enroll_pk: randomBytes(32),
    exp: 1n,
    root_epoch: 0,
    signer,
    credential_id: signer === 'passkey' ? 'cred-1' : null,
  });
}

function pathIndex(paths: string[], path: string): number {
  const index = paths.indexOf(path);
  expect(index).toBeGreaterThan(-1);
  return index;
}

const ATTACHED_STATUS = {
  mode: 'relay',
  tenantId: 'd'.repeat(32),
  relays: [{ url: RELAY_URL, priority: 0, online: true, attached: true, rttMs: 12 }],
  metaEpoch: 1,
  nodesViaRelay: 2,
  reauthRequired: false,
};

describe('relay enroll', () => {
  test('health → readmit → proof → enroll → signed set-relays → status poll', async () => {
    const auth = await openAuth();
    const logs: string[] = [];
    const { calls, fetcher } = fakeGateway(auth, {
      status: [{ mode: 'hub', relays: [] }, ATTACHED_STATUS],
    });
    const result = await runRelayEnroll(
      parseArgs(['relay', 'enroll', RELAY_URL]),
      RELAY_URL,
      io(auth, fetcher, logs)
    );
    expect(result.relayUrl).toBe(RELAY_URL);
    expect(result.online).toBe(true);
    const paths = calls.map((call) => call.path);
    expect(paths[0]).toBe('/api/relay/health');
    const prepareIdx = pathIndex(paths, '/api/mesh/relay/readmit/prepare');
    const proofIdx = pathIndex(paths, '/api/mesh/relay/enroll/proof-material');
    const enrollIdx = pathIndex(paths, '/api/mesh/relay/enroll');
    const appendIdx = pathIndex(paths, '/api/auth/keylog?hub=sync');
    expect(prepareIdx).toBeLessThan(proofIdx);
    expect(proofIdx).toBeLessThan(enrollIdx);
    expect(enrollIdx).toBeLessThan(appendIdx);
    expect(paths).toContain('/api/auth/keylog/head');
    expect(paths.filter((path) => path === '/api/mesh/relay/status')).toHaveLength(2);
    expect(logs.at(-1)).toContain(RELAY_URL);
  });

  test('the enroll body carries the relay password and a root-signed proof', async () => {
    const auth = await openAuth();
    const { calls, fetcher, user } = fakeGateway(auth, { status: [ATTACHED_STATUS] });
    await runRelayEnroll(
      parseArgs(['relay', 'enroll', RELAY_URL]),
      RELAY_URL,
      io(auth, fetcher, [])
    );
    const enroll = calls.find((call) => call.path === '/api/mesh/relay/enroll');
    expect(enroll?.method).toBe('POST');
    expect(enroll?.body?.url).toBe(RELAY_URL);
    expect(enroll?.body?.password).toBe('relay-site-password');
    expect(enroll?.body?.ts).toBe(1_760_000_000_000);
    const proof = enroll?.body?.proof as { bytes: string; sig: string };
    const sig = decodeBase64url(proof.sig);
    expect(sig).toHaveLength(64);
    expect(decodeRelayEnrollProof(decodeBase64url(proof.bytes)).relay_host).toBe(RELAY_HOST);
    const { signRelayEnrollProof } = await import('../../../shared/src/relay');
    const rebuilt = signRelayEnrollProof(
      { publicKey: user.rootPublicKey, sign: () => new Uint8Array(64) },
      { relayHost: RELAY_HOST, ts: 1_760_000_000_000 }
    );
    expect(decodeBase64url(proof.bytes)).toEqual(rebuilt.bytes);
    const verified = verifyRelayEnrollProof({
      bytes: rebuilt.bytes,
      sig,
      relayHost: RELAY_HOST,
      rootPublicKey: user.rootPublicKey,
    });
    expect(verified.ok).toBe(true);
    expect(decodeRelayEnrollProof(rebuilt.bytes).relay_host).toBe(RELAY_HOST);
  });

  test('the appended record is a root-signed set-relays on the current head', async () => {
    const auth = await openAuth();
    const { calls, fetcher, user } = fakeGateway(auth, { status: [ATTACHED_STATUS] });
    await runRelayEnroll(
      parseArgs(['relay', 'enroll', RELAY_URL]),
      RELAY_URL,
      io(auth, fetcher, [])
    );
    const append = calls.find((call) => call.path === '/api/auth/keylog?hub=sync');
    const bytes = decodeBase64url(String(append?.body?.bytes));
    const sig = decodeBase64url(String(append?.body?.sig));
    const record = decodeKeyLogRecord(bytes);
    expect(record.type).toBe('set-relays');
    expect(record.signer).toBe('root');
    expect(record.uid).toBe(user.id);
    expect(record.seq).toBe(BigInt(user.keyLogHeadSeq) + 1n);
    expect(new Uint8Array(record.prev_hash)).toEqual(new Uint8Array(user.keyLogHeadHash));
    expect(new Uint8Array(record.payload)).toEqual(SET_RELAYS_PAYLOAD);
    expect(verifyEd25519(sig, bytes, user.rootPublicKey)).toBe(true);
  });

  test('enroll re-affirms stale members before enroll and set-relays', async () => {
    const auth = await openAuth();
    const logs: string[] = [];
    const passkeyAuth = sampleAuthorization(
      auth.userStore.getByUsername('ivy')?.id ?? '',
      'passkey'
    );
    const rootAuth = sampleAuthorization(auth.userStore.getByUsername('ivy')?.id ?? '', 'root');
    const certificate = randomBytes(16);
    const certSig = randomBytes(64);
    const { calls, fetcher, user } = fakeGateway(auth, {
      status: [ATTACHED_STATUS],
      readmitPrepare: {
        rootEpoch: 4,
        entries: [
          {
            nodeId: 'ab'.repeat(16),
            name: 'studio',
            admitSeq: 2,
            admitRootEpoch: 1,
            authorization_bytes: encodeBase64url(passkeyAuth),
            certificate_bytes: encodeBase64url(certificate),
            cert_sig: encodeBase64url(certSig),
          },
          {
            nodeId: 'cd'.repeat(16),
            name: 'box',
            admitSeq: 3,
            admitRootEpoch: 1,
            authorization_bytes: encodeBase64url(rootAuth),
            certificate_bytes: encodeBase64url(certificate),
            cert_sig: encodeBase64url(certSig),
          },
        ],
      },
    });
    await runRelayEnroll(
      parseArgs(['relay', 'enroll', RELAY_URL]),
      RELAY_URL,
      io(auth, fetcher, logs)
    );
    expect(logs.some((line) => line.includes('re-affirmed 2 member(s) under root epoch 4'))).toBe(
      true
    );
    const paths = calls.map((call) => call.path);
    const prepareIdx = pathIndex(paths, '/api/mesh/relay/readmit/prepare');
    const firstAppendIdx = pathIndex(paths, '/api/auth/keylog?hub=sync');
    const proofIdx = pathIndex(paths, '/api/mesh/relay/enroll/proof-material');
    const enrollIdx = pathIndex(paths, '/api/mesh/relay/enroll');
    expect(prepareIdx).toBeLessThan(firstAppendIdx);
    expect(firstAppendIdx).toBeLessThan(proofIdx);
    expect(proofIdx).toBeLessThan(enrollIdx);
    const appends = calls.filter((call) => call.path === '/api/auth/keylog?hub=sync');
    expect(appends).toHaveLength(3);
    const first = decodeKeyLogRecord(decodeBase64url(String(appends[0]?.body?.bytes)));
    const second = decodeKeyLogRecord(decodeBase64url(String(appends[1]?.body?.bytes)));
    const third = decodeKeyLogRecord(decodeBase64url(String(appends[2]?.body?.bytes)));
    expect(first.type).toBe('readmit-node');
    expect(second.type).toBe('readmit-node');
    expect(third.type).toBe('set-relays');
    for (const record of [first, second]) {
      const payload = decodeAdmitNodePayload(record.payload);
      const rebuilt = decodeAuthorization(payload.authorization_bytes);
      expect(rebuilt.signer).toBe('root');
      expect(rebuilt.credential_id).toBeNull();
      expect(rebuilt.root_epoch).toBe(4);
      expect(rebuilt.uid).toBe(user.id);
      expect(payload.certificate_bytes).toEqual(certificate);
      expect(
        verifyEd25519(payload.authorization_sig, payload.authorization_bytes, user.rootPublicKey)
      ).toBe(true);
    }
    expect(decodeAdmitNodePayload(first.payload).authorization_bytes).not.toEqual(passkeyAuth);
  });

  test('enroll aborts set-relays when a readmit-node append fails', async () => {
    const auth = await openAuth();
    const user = auth.userStore.getByUsername('ivy');
    if (!user) throw new Error('missing ivy');
    const { calls, fetcher } = fakeGateway(auth, {
      status: [ATTACHED_STATUS],
      readmitPrepare: {
        rootEpoch: 4,
        entries: [
          {
            nodeId: 'cd'.repeat(16),
            name: 'box',
            admitSeq: 2,
            admitRootEpoch: 1,
            authorization_bytes: encodeBase64url(sampleAuthorization(user.id, 'passkey')),
            certificate_bytes: encodeBase64url(randomBytes(8)),
            cert_sig: encodeBase64url(randomBytes(64)),
          },
        ],
      },
      appends: [
        () =>
          new Response(JSON.stringify({ error: 'bad_authorization_sig' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      ],
    });
    await expect(
      runRelayEnroll(parseArgs(['relay', 'enroll', RELAY_URL]), RELAY_URL, io(auth, fetcher, []))
    ).rejects.toThrow(/failed to re-affirm member/);
    const appends = calls.filter((call) => call.path === '/api/auth/keylog?hub=sync');
    expect(appends).toHaveLength(1);
    expect(decodeKeyLogRecord(decodeBase64url(String(appends[0]?.body?.bytes))).type).toBe(
      'readmit-node'
    );
    expect(calls.some((call) => call.path === '/api/mesh/relay/enroll')).toBe(false);
    expect(calls.some((call) => call.path === '/api/mesh/relay/enroll/proof-material')).toBe(false);
  });

  test('enroll aborts set-relays when readmitRequired remains after enroll', async () => {
    const auth = await openAuth();
    const { calls, fetcher } = fakeGateway(auth, {
      status: [ATTACHED_STATUS],
      enroll: () =>
        new Response(
          JSON.stringify({
            tenantId: 'd'.repeat(32),
            token: encodeBase64url(randomBytes(32)),
            passwordEpoch: 1,
            metaEpoch: 1,
            payload: encodeBase64url(SET_RELAYS_PAYLOAD),
            payloadHash: encodeBase64url(randomBytes(32)),
            readmitRequired: 2,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    });
    await expect(
      runRelayEnroll(parseArgs(['relay', 'enroll', RELAY_URL]), RELAY_URL, io(auth, fetcher, []))
    ).rejects.toThrow(/still need re-affirming after enroll \(2\)/);
    expect(calls.some((call) => call.path === '/api/mesh/relay/enroll')).toBe(true);
    expect(calls.some((call) => call.path === '/api/auth/keylog?hub=sync')).toBe(false);
  });

  test('a relay that is not healthy stops before touching the local gateway', async () => {
    const auth = await openAuth();
    const url = `${RELAY_URL}:8443`;
    const { calls, fetcher } = fakeGateway(auth, { health: { ok: false } });
    await expect(
      runRelayEnroll(parseArgs(['relay', 'enroll', url]), url, io(auth, fetcher, []))
    ).rejects.toThrow('relay is not healthy');
    expect(calls).toHaveLength(1);
  });

  test('an explicit :443 is confirmed as written and never swept', async () => {
    const auth = await openAuth();
    const url = `${RELAY_URL}:443`;
    const seen: string[] = [];
    const { fetcher } = fakeGateway(auth, { health: { ok: false } });
    const spy = (async (input: unknown, init?: RequestInit) => {
      const target = new URL(String(input));
      if (target.hostname === new URL(RELAY_URL).hostname) {
        seen.push(`${target.port || '443'}${target.pathname}`);
      }
      return await fetcher(input as string, init as RequestInit);
    }) as typeof fetcher;
    await expect(
      runRelayEnroll(parseArgs(['relay', 'enroll', url]), url, io(auth, spy, []))
    ).rejects.toThrow('relay is not healthy');
    // 归一化会抹掉 :443；按原始输入判断显式端口，所以只确认这一次，不遍历候选
    expect(seen).toEqual(['443/api/relay/health']);
  });

  test('a portless url with no reachable candidate port names the ports tried', async () => {
    const auth = await openAuth();
    const { fetcher } = fakeGateway(auth, { health: { ok: false } });
    await expect(
      runRelayEnroll(parseArgs(['relay', 'enroll', RELAY_URL]), RELAY_URL, io(auth, fetcher, []))
    ).rejects.toThrow(/443/);
  });

  test('a missing url is refused', async () => {
    const auth = await openAuth();
    const { fetcher } = fakeGateway(auth);
    await expect(
      runRelayEnroll(parseArgs(['relay', 'enroll']), '', io(auth, fetcher, []))
    ).rejects.toThrow('relay enroll requires <url>');
  });

  test('a still-detached relay is reported as pending instead of done', async () => {
    const auth = await openAuth();
    const logs: string[] = [];
    const { fetcher } = fakeGateway(auth, {
      status: [
        { mode: 'hub', relays: [{ url: RELAY_URL, priority: 0, lastError: 'ECONNREFUSED' }] },
      ],
    });
    const result = await runRelayEnroll(
      parseArgs(['relay', 'enroll', RELAY_URL]),
      RELAY_URL,
      io(auth, fetcher, logs)
    );
    expect(result.online).toBe(false);
    expect(logs.at(-1)).toContain('ECONNREFUSED');
  });
});

describe('relay pack upload', () => {
  test.each([
    ['enroll', runRelayEnroll],
    ['reauth', runRelayReauth],
  ] as const)(
    '%s fails with a retry command when sealed pack upload fails',
    async (command, run) => {
      const auth = await openAuth();
      const logs: string[] = [];
      const { fetcher, calls } = fakeGateway(auth, {
        status: [ATTACHED_STATUS],
        pack: () => new Response(JSON.stringify({ code: 'PACK_UNAVAILABLE' }), { status: 503 }),
      });
      await expect(
        run(parseArgs(['relay', command, RELAY_URL]), RELAY_URL, io(auth, fetcher, logs))
      ).rejects.toThrow(
        'Relay pack upload failed: PACK_UNAVAILABLE (HTTP 503) Retry: vibeterm relay pack upload'
      );
      expect(calls.some((call) => call.path === '/api/auth/keylog?hub=sync')).toBe(true);
      expect(logs.some((line) => line.includes('attached to relay'))).toBe(false);
    }
  );

  test('missing local material is a hard failure with installation-specific retry', async () => {
    const auth = await openAuth();
    new MeshRelayStore(auth.db).clearRelays();
    const { fetcher } = fakeGateway(auth, { status: [ATTACHED_STATUS] });
    await expect(
      runRelayEnroll(
        parseArgs([
          'relay',
          'enroll',
          RELAY_URL,
          '--install-dir',
          "/tmp/ivy's node",
          '--service-name',
          'dev',
        ]),
        RELAY_URL,
        io(auth, fetcher, [])
      )
    ).rejects.toThrow(
      "Retry: vibeterm relay pack upload --install-dir '/tmp/ivy'\\''s node' --service-name 'dev'"
    );
  });

  test('pack upload authenticates and uploads the current pack without another enroll or append', async () => {
    const auth = await openAuth();
    const logs: string[] = [];
    const { fetcher, calls, user } = fakeGateway(auth);
    const token = randomBytes(32);
    await new MeshRelayStore(auth.db).setRelayToken({
      url: RELAY_URL,
      tenantId: 'd'.repeat(32),
      token,
      now: Date.now(),
    });
    await runRelayPackUpload(parseArgs(['relay', 'pack', 'upload']), io(auth, fetcher, logs));
    const uploaded = calls.find((call) => call.path.endsWith('/pack'));
    const rootKey = await deriveRootKey(PASSWORD, kdfParamsFromJson(user.kdfParamsJson));
    const pack = await openRelayPack({
      rootSeed: rootKey.seed,
      rootPublicKey: user.rootPublicKey,
      rootEpoch: user.rootEpoch,
      tenantId: 'd'.repeat(32),
      sealedPack: decodeBase64url(String(uploaded?.body?.sealed_pack)),
    });
    expect(pack.token).toEqual(token);
    expect(pack.head_seq).toBe(BigInt(user.keyLogHeadSeq));
    const paths = calls.map((call) => call.path);
    expect(paths).toContain('/api/auth/login');
    expect(paths).toContain(`/api/relay/tenants/${'d'.repeat(32)}/pack`);
    expect(paths).not.toContain('/api/mesh/relay/enroll');
    expect(paths).not.toContain('/api/auth/keylog?hub=sync');
    expect(logs).toEqual(['Current sealed relay packs uploaded.']);
  });

  test.each([0, 1])(
    'partial pack upload failure is reported when relay %i fails',
    async (failedIndex) => {
      const auth = await openAuth();
      await new MeshRelayStore(auth.db).setRelayToken({
        url: `${RELAY_URL}:8443`,
        tenantId: 'e'.repeat(32),
        token: randomBytes(32),
        now: Date.now(),
      });
      let uploads = 0;
      const { fetcher } = fakeGateway(auth, {
        pack: () => new Response('{}', { status: uploads++ === failedIndex ? 503 : 200 }),
      });
      await expect(
        runRelayPackUpload(parseArgs(['relay', 'pack', 'upload']), io(auth, fetcher, []))
      ).rejects.toThrow('Retry: vibeterm relay pack upload');
      expect(uploads).toBe(2);
    }
  );

  test('stale token pack rejection tells the operator to catch up before retrying', async () => {
    const auth = await openAuth();
    const logs: string[] = [];
    const { fetcher } = fakeGateway(auth, {
      pack: () =>
        new Response(JSON.stringify({ error: { code: 'RELAY_TOKEN_NOT_CURRENT' } }), {
          status: 409,
        }),
    });
    await expect(
      runRelayPackUpload(parseArgs(['relay', 'pack', 'upload']), io(auth, fetcher, logs))
    ).rejects.toThrow(
      'First run vibeterm relay resend-token on a node with the current token, or join with your password on this node'
    );
    expect(logs).toEqual([]);
  });

  test('pack-only retry also fails when upload fails', async () => {
    const auth = await openAuth();
    const { fetcher } = fakeGateway(auth, { pack: () => new Response('{}', { status: 503 }) });
    await expect(
      runRelayPackUpload(parseArgs(['relay', 'pack', 'upload']), io(auth, fetcher, []))
    ).rejects.toThrow('Retry: vibeterm relay pack upload');
  });
});

describe('并发追加下的 set-relays', () => {
  const conflict = () =>
    new Response(JSON.stringify({ code: 'seq_gap' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });

  test('浏览器抢先追加时重读 head、重取 payload 再签一次', async () => {
    const auth = await openAuth();
    const { calls, fetcher } = fakeGateway(auth, {
      status: [ATTACHED_STATUS],
      appends: [conflict],
    });
    const result = await runRelayEnroll(
      parseArgs(['relay', 'enroll', RELAY_URL]),
      RELAY_URL,
      io(auth, fetcher, [])
    );
    expect(result.online).toBe(true);
    const paths = calls.map((call) => call.path);
    expect(paths.filter((path) => path === '/api/auth/keylog/head')).toHaveLength(2);
    expect(paths.filter((path) => path === '/api/auth/keylog?hub=sync')).toHaveLength(2);
    // payload 是重新问节点要的，不是拿旧的重签。
    expect(paths.filter((path) => path === '/api/mesh/relay/enroll')).toHaveLength(2);
  });

  test('重试次数用尽后把中继的错误原样抛出', async () => {
    const auth = await openAuth();
    const { calls, fetcher } = fakeGateway(auth, {
      status: [ATTACHED_STATUS],
      appends: [conflict, conflict, conflict, conflict, conflict],
    });
    await expect(
      runRelayEnroll(parseArgs(['relay', 'enroll', RELAY_URL]), RELAY_URL, io(auth, fetcher, []))
    ).rejects.toThrow('seq_gap');
    expect(calls.filter((call) => call.path === '/api/auth/keylog?hub=sync')).toHaveLength(
      RELAY_RECORD_MAX_ATTEMPTS
    );
  });

  test('根钥在中途轮换过就不再重签，直接报错', async () => {
    const auth = await openAuth();
    const { calls, fetcher } = fakeGateway(auth, {
      status: [ATTACHED_STATUS],
      appends: [conflict],
      headEpochs: [0, 1],
    });
    await expect(
      runRelayEnroll(parseArgs(['relay', 'enroll', RELAY_URL]), RELAY_URL, io(auth, fetcher, []))
    ).rejects.toThrow(RELAY_ROOT_ROTATED);
    expect(calls.filter((call) => call.path === '/api/auth/keylog?hub=sync')).toHaveLength(1);
  });
});

describe('relay leave', () => {
  test('signs an empty set-relays and reports the new mode', async () => {
    const auth = await openAuth();
    const logs: string[] = [];
    const { calls, fetcher } = fakeGateway(auth, { status: [{ mode: 'none', relays: [] }] });
    const result = await runRelayLeave(parseArgs(['relay', 'leave']), io(auth, fetcher, logs));
    expect(result.mode).toBe('none');
    const paths = calls.map((call) => call.path);
    expect(paths).toContain('/api/auth/login');
    expect(paths).toContain('/api/mesh/relay/leave/prepare');
    const append = calls.find((call) => call.path === '/api/auth/keylog?hub=sync');
    expect(decodeKeyLogRecord(decodeBase64url(String(append?.body?.bytes))).type).toBe(
      'set-relays'
    );
    expect(logs.at(-1)).toContain('left the relay');
  });

  test('a prepare response without a payload is a clear error', async () => {
    const auth = await openAuth();
    const { fetcher } = fakeGateway(auth, { leave: {} });
    await expect(
      runRelayLeave(parseArgs(['relay', 'leave']), io(auth, fetcher, []))
    ).rejects.toThrow('no set-relays payload');
  });
});

describe('relay resend-token', () => {
  test('按当前中继表重签一条 set-relays 并报告覆盖的节点数', async () => {
    const auth = await openAuth();
    const logs: string[] = [];
    const { calls, fetcher } = fakeGateway(auth);
    const result = await runRelayResendToken(
      parseArgs(['relay', 'resend-token']),
      io(auth, fetcher, logs)
    );
    expect(result.nodes).toBe(3);
    const paths = calls.map((call) => call.path);
    expect(paths).toContain('/api/mesh/relay/resend-token/prepare');
    const append = calls.find((call) => call.path === '/api/auth/keylog?hub=sync');
    expect(decodeKeyLogRecord(decodeBase64url(String(append?.body?.bytes))).type).toBe(
      'set-relays'
    );
    expect(logs.at(-1)).toContain('3');
  });

  test.each([{ relayAck: false, relayError: 'RELAY_UNAVAILABLE' }, { relayAck: false }, {}])(
    'unacknowledged append is not reported as successful: %j',
    async (response) => {
      const auth = await openAuth();
      const logs: string[] = [];
      const { fetcher, calls } = fakeGateway(auth, {
        appends: [() => new Response(JSON.stringify({ seq: 2, ...response }))],
      });
      await expect(
        runRelayResendToken(parseArgs(['relay', 'resend-token']), io(auth, fetcher, logs))
      ).rejects.toThrow('Relay did not acknowledge set-relays:');
      expect(calls.filter((call) => call.path === '/api/auth/keylog?hub=sync')).toHaveLength(1);
      expect(logs).toEqual([]);
    }
  );

  test('prepare 没给 payload 时报错清楚', async () => {
    const auth = await openAuth();
    const { fetcher } = fakeGateway(auth, { resendToken: {} });
    await expect(
      runRelayResendToken(parseArgs(['relay', 'resend-token']), io(auth, fetcher, []))
    ).rejects.toThrow('no set-relays payload');
  });
});

describe('relay list', () => {
  test('prints mode, tenant and one row per relay', async () => {
    const auth = await openAuth();
    const logs: string[] = [];
    const { fetcher } = fakeGateway(auth, { status: [ATTACHED_STATUS] });
    await runRelayList(parseArgs(['relay', 'list']), io(auth, fetcher, logs));
    expect(logs[0]).toBe('mode: relay');
    expect(logs[1]).toBe(`tenant: ${'d'.repeat(32)}`);
    expect(logs).toContain('meta epoch: 1');
    expect(logs.some((line) => line.includes('PRI'))).toBe(true);
    expect(logs.some((line) => line.includes('online') && line.includes('attached'))).toBe(true);
  });

  test('--json prints the raw status body', async () => {
    const auth = await openAuth();
    const logs: string[] = [];
    const { fetcher } = fakeGateway(auth, { status: [ATTACHED_STATUS] });
    await runRelayList(parseArgs(['relay', 'list', '--json']), io(auth, fetcher, logs));
    expect(JSON.parse(logs.join('\n')).mode).toBe('relay');
  });

  test('loopback list 不打开 node-session', async () => {
    const auth = await openAuth();
    const logs: string[] = [];
    const { calls, fetcher } = fakeGateway(auth, { status: [ATTACHED_STATUS] });
    await runRelayList(parseArgs(['relay', 'list']), io(auth, fetcher, logs));
    expect(calls.some((call) => call.path === '/api/auth/login')).toBe(false);
    expect(logs[0]).toBe('mode: relay');
  });

  test('status 401 时回退到 node-session', async () => {
    const auth = await openAuth();
    const logs: string[] = [];
    const { calls, fetcher } = fakeGateway(auth, {
      status: [ATTACHED_STATUS],
      rejectUnauthedStatus: true,
    });
    await runRelayList(parseArgs(['relay', 'list']), io(auth, fetcher, logs));
    expect(calls.some((call) => call.path === '/api/auth/login')).toBe(true);
    expect(logs[0]).toBe('mode: relay');
  });
});

describe('formatting helpers', () => {
  test('formatRelayStatusLines reports an empty list and a reauth hint', () => {
    const lines = formatRelayStatusLines({
      mode: 'none',
      tenantId: null,
      relays: [],
      metaEpoch: 0,
      nodesViaRelay: 0,
      reauthRequired: true,
      readmitPending: 0,
      raw: {},
    });
    expect(lines).toContain('no relays configured');
    expect(lines.some((line) => line.includes('reauth required'))).toBe(true);
  });

  test('parseRelayHealth keeps hasPassword unknown when the relay omits it', () => {
    expect(parseRelayHealth({ ok: true, version: '1.1.23' }).hasPassword).toBeNull();
    expect(parseRelayHealth({ ok: true, hasPassword: false }).hasPassword).toBe(false);
  });
});
