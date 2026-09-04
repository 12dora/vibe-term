import './test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { createMigratedAuthDb } from '../../../../apps/gateway/src/auth/test-db';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  deriveTotpKey,
  encodeBase64url,
  randomBytes,
} from '../../../shared/src/auth';
import { JoinError } from '../commands/hub';
import { runHubJoin, runHubUserAdd } from '../commands/hub';
import { parseArgs } from './args';
import type { FetchLike } from './fetch-like';
import { HUB_JOIN_ADMIT_ATTEMPTS, publishHubJoinSelfAdmit } from './hub-password-self-admit';
import { type LocalAuthContext, createAuthContextFromDb, openLocalAuth } from './local-auth';

const HUB = 'https://hub.example';
const PASSWORD = 'tmex-test-pass';

function b64(bytes: Uint8Array): string {
  return encodeBase64url(bytes);
}

async function bootJoiner(opts?: { selfAdmit?: boolean }) {
  const created = createMigratedAuthDb();
  const auth = await createAuthContextFromDb(created.db, { close: created.close });
  const identity = await ensureNodeIdentity(auth.identityStore);
  const boot = opts?.selfAdmit
    ? await auth.userKeys.bootstrapUserWithSelfAdmit({
        username: 'alice',
        password: PASSWORD,
        identity,
      })
    : await auth.userKeys.bootstrapUser({ username: 'alice', password: PASSWORD });
  return { ...created, auth, identity, boot };
}

function modeBody(
  uid: string,
  extras?: { totpEnabled?: boolean; passkeySecondFactor?: boolean }
): Record<string, unknown> {
  return {
    mode: 'mesh',
    nodeId: 'self',
    uid,
    totpEnabled: extras?.totpEnabled === true,
    passkeySecondFactor: extras?.passkeySecondFactor === true,
  };
}

function hubAdmitFetcher(opts: {
  uid: string;
  head: { seq: bigint; hash: Uint8Array; rootEpoch: number };
  posts?: Array<{ status: number; body: unknown }>;
  onPost?: (body: Record<string, unknown>) => void;
  onLogin?: (body: Record<string, unknown>) => void;
  totpEnabled?: boolean;
  passkeySecondFactor?: boolean;
  loginStatus?: number;
  loginBody?: Record<string, unknown>;
}): FetchLike {
  const posts = opts.posts ?? [
    { status: 200, body: { ok: true, seq: 2, hash: b64(randomBytes(32)) } },
  ];
  let postIdx = 0;
  return async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/api/auth/mode')) {
      return Response.json(
        modeBody(opts.uid, {
          totpEnabled: opts.totpEnabled,
          passkeySecondFactor: opts.passkeySecondFactor,
        })
      );
    }
    if (url.endsWith('/api/auth/challenge') && method === 'POST') {
      return Response.json({
        challenge_id: 'ch-1',
        nonce: b64(randomBytes(32)),
        nodePk: b64(randomBytes(32)),
      });
    }
    if (url.endsWith('/api/auth/login') && method === 'POST') {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      opts.onLogin?.(JSON.parse(raw) as Record<string, unknown>);
      if (opts.loginStatus && opts.loginStatus >= 400) {
        return Response.json(opts.loginBody ?? { code: 'UNAUTHORIZED' }, {
          status: opts.loginStatus,
        });
      }
      return new Response(JSON.stringify({ ok: true, expires_at: Date.now() + 60_000 }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-tmex-set-session': 'sid-join',
        },
      });
    }
    if (url.endsWith('/api/auth/keylog/head')) {
      return Response.json({
        seq: Number(opts.head.seq),
        hash: b64(opts.head.hash),
        rootEpoch: opts.head.rootEpoch,
        uid: opts.uid,
      });
    }
    if (url.endsWith('/api/auth/keylog') && method === 'POST') {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      opts.onPost?.(JSON.parse(raw) as Record<string, unknown>);
      const spec = posts[Math.min(postIdx, posts.length - 1)] ?? posts[0];
      postIdx += 1;
      return Response.json(spec?.body ?? { ok: true }, { status: spec?.status ?? 200 });
    }
    return new Response('nope', { status: 404 });
  };
}

describe('publishHubJoinSelfAdmit', () => {
  test('posts a root-signed admit-node and applies it locally', async () => {
    const ctx = await bootJoiner();
    try {
      const state = ctx.auth.userKeys.currentState(ctx.boot.userId);
      const posted: Record<string, unknown>[] = [];
      const result = await publishHubJoinSelfAdmit({
        auth: ctx.auth,
        hubUrl: HUB,
        userId: ctx.boot.userId,
        rootKey: ctx.boot.rootKey,
        fetcher: hubAdmitFetcher({
          uid: ctx.boot.userId,
          head: { seq: state.head.seq, hash: state.head.hash, rootEpoch: state.rootEpoch },
          onPost: (body) => posted.push(body),
        }),
      });
      expect(result.appended).toBe(true);
      expect(posted).toHaveLength(1);
      const record = decodeKeyLogRecord(decodeBase64url(String(posted[0]?.bytes)));
      expect(record.type).toBe('admit-node');
      expect(
        ctx.auth.userKeys.currentState(ctx.boot.userId).nodeCerts.has(ctx.identity.nodeIdHex)
      ).toBe(true);
    } finally {
      ctx.close();
    }
  });

  test('retries when the hub head moved', async () => {
    const ctx = await bootJoiner();
    try {
      const state = ctx.auth.userKeys.currentState(ctx.boot.userId);
      let posts = 0;
      const result = await publishHubJoinSelfAdmit({
        auth: ctx.auth,
        hubUrl: HUB,
        userId: ctx.boot.userId,
        rootKey: ctx.boot.rootKey,
        fetcher: hubAdmitFetcher({
          uid: ctx.boot.userId,
          head: { seq: state.head.seq, hash: state.head.hash, rootEpoch: state.rootEpoch },
          posts: [
            { status: 409, body: { code: 'KEY_LOG_FORK' } },
            { status: 200, body: { ok: true, seq: 3 } },
          ],
          onPost: () => {
            posts += 1;
          },
        }),
      });
      expect(result.appended).toBe(true);
      expect(posts).toBe(2);
      expect(posts).toBeLessThanOrEqual(HUB_JOIN_ADMIT_ATTEMPTS);
    } finally {
      ctx.close();
    }
  });

  test('skips when the node is already admitted locally', async () => {
    const ctx = await bootJoiner({ selfAdmit: true });
    try {
      let keylogPosts = 0;
      const result = await publishHubJoinSelfAdmit({
        auth: ctx.auth,
        hubUrl: HUB,
        userId: ctx.boot.userId,
        rootKey: ctx.boot.rootKey,
        fetcher: async (input) => {
          if (String(input).includes('/api/auth/keylog') && !String(input).includes('head')) {
            keylogPosts += 1;
          }
          return new Response('nope', { status: 500 });
        },
      });
      expect(result.appended).toBe(false);
      expect(result.admitPending).toBe(false);
      expect(keylogPosts).toBe(0);
    } finally {
      ctx.close();
    }
  });

  test('TOTP enabled with a code logs in and appends admit-node', async () => {
    const ctx = await bootJoiner();
    try {
      const state = ctx.auth.userKeys.currentState(ctx.boot.userId);
      const logins: Record<string, unknown>[] = [];
      const result = await publishHubJoinSelfAdmit({
        auth: ctx.auth,
        hubUrl: HUB,
        userId: ctx.boot.userId,
        rootKey: ctx.boot.rootKey,
        totpCode: '123456',
        fetcher: hubAdmitFetcher({
          uid: ctx.boot.userId,
          head: { seq: state.head.seq, hash: state.head.hash, rootEpoch: state.rootEpoch },
          totpEnabled: true,
          onLogin: (body) => logins.push(body),
        }),
      });
      expect(result).toEqual({ appended: true, admitPending: false });
      const totp = logins[0]?.totp as { code?: string; k_totp?: string } | undefined;
      expect(totp?.code).toBe('123456');
      const user = ctx.auth.userStore.getById(ctx.boot.userId);
      expect(totp?.k_totp).toBe(
        b64(deriveTotpKey(ctx.boot.rootKey.seed, ctx.boot.userId, user?.rootEpoch ?? 0))
      );
    } finally {
      ctx.close();
    }
  });

  test('TOTP enabled without a code returns totp_required', async () => {
    const ctx = await bootJoiner();
    try {
      const state = ctx.auth.userKeys.currentState(ctx.boot.userId);
      const err = await publishHubJoinSelfAdmit({
        auth: ctx.auth,
        hubUrl: HUB,
        userId: ctx.boot.userId,
        rootKey: ctx.boot.rootKey,
        fetcher: hubAdmitFetcher({
          uid: ctx.boot.userId,
          head: { seq: state.head.seq, hash: state.head.hash, rootEpoch: state.rootEpoch },
          totpEnabled: true,
        }),
      }).catch((error) => error);
      expect(err).toBeInstanceOf(JoinError);
      expect((err as JoinError).code).toBe('totp_required');
    } finally {
      ctx.close();
    }
  });

  test('TOTP_INVALID from hub maps to totp_invalid', async () => {
    const ctx = await bootJoiner();
    try {
      const state = ctx.auth.userKeys.currentState(ctx.boot.userId);
      const err = await publishHubJoinSelfAdmit({
        auth: ctx.auth,
        hubUrl: HUB,
        userId: ctx.boot.userId,
        rootKey: ctx.boot.rootKey,
        totpCode: '000000',
        fetcher: hubAdmitFetcher({
          uid: ctx.boot.userId,
          head: { seq: state.head.seq, hash: state.head.hash, rootEpoch: state.rootEpoch },
          totpEnabled: true,
          loginStatus: 401,
          loginBody: { code: 'TOTP_INVALID' },
        }),
      }).catch((error) => error);
      expect(err).toBeInstanceOf(JoinError);
      expect((err as JoinError).code).toBe('totp_invalid');
    } finally {
      ctx.close();
    }
  });

  test('passkey-only accounts skip self-admit with admitPending', async () => {
    const ctx = await bootJoiner();
    try {
      const state = ctx.auth.userKeys.currentState(ctx.boot.userId);
      let logins = 0;
      let posts = 0;
      const result = await publishHubJoinSelfAdmit({
        auth: ctx.auth,
        hubUrl: HUB,
        userId: ctx.boot.userId,
        rootKey: ctx.boot.rootKey,
        fetcher: hubAdmitFetcher({
          uid: ctx.boot.userId,
          head: { seq: state.head.seq, hash: state.head.hash, rootEpoch: state.rootEpoch },
          passkeySecondFactor: true,
          onLogin: () => {
            logins += 1;
          },
          onPost: () => {
            posts += 1;
          },
        }),
      });
      expect(result).toEqual({ appended: false, admitPending: true });
      expect(logins).toBe(0);
      expect(posts).toBe(0);
    } finally {
      ctx.close();
    }
  });

  test('TOTP+passkey combined accounts stay on the pending path', async () => {
    const ctx = await bootJoiner();
    try {
      const state = ctx.auth.userKeys.currentState(ctx.boot.userId);
      let logins = 0;
      const result = await publishHubJoinSelfAdmit({
        auth: ctx.auth,
        hubUrl: HUB,
        userId: ctx.boot.userId,
        rootKey: ctx.boot.rootKey,
        totpCode: '123456',
        fetcher: hubAdmitFetcher({
          uid: ctx.boot.userId,
          head: { seq: state.head.seq, hash: state.head.hash, rootEpoch: state.rootEpoch },
          totpEnabled: true,
          passkeySecondFactor: true,
          onLogin: () => {
            logins += 1;
          },
        }),
      });
      expect(result).toEqual({ appended: false, admitPending: true });
      expect(logins).toBe(0);
    } finally {
      ctx.close();
    }
  });
});

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const handles: LocalAuthContext[] = [];

afterEach(() => {
  for (const ctx of handles.splice(0)) ctx.close();
});

async function openAuth(roles: string): Promise<LocalAuthContext> {
  const ctx = await openLocalAuth({
    memory: true,
    migrationsFolder: MIGRATIONS,
    env: { TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '', TMEX_ROLES: roles },
  });
  handles.push(ctx);
  return ctx;
}

function passwordJoinFetcher(
  hub: LocalAuthContext,
  user: NonNullable<ReturnType<LocalAuthContext['userStore']['getById']>>,
  opts?: {
    totpEnabled?: boolean;
    passkeySecondFactor?: boolean;
    posted?: Record<string, unknown>[];
    logins?: Record<string, unknown>[];
  }
): FetchLike {
  const kdfParams = JSON.parse(user.kdfParamsJson) as Record<string, unknown>;
  return async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const live = hub.userStore.getById(user.id) ?? user;
    const records = hub.keyLogStore.list(user.id);
    const head = hub.keyLogStore.head(user.id);
    const certs = hub.userStore.listCertsByUser(user.id);
    if (url.endsWith('/api/auth/mode')) {
      return Response.json({
        mode: 'mesh',
        nodeId: 'self',
        uid: user.id,
        username: live.username,
        totpEnabled: opts?.totpEnabled === true,
        passkeySecondFactor: opts?.passkeySecondFactor === true,
        kdfParams,
        rootEpoch: live.rootEpoch,
      });
    }
    if (url.endsWith('/api/hub/enrollments/by-password') && method === 'POST') {
      return Response.json({
        ok: true,
        id: 'enroll-1',
        key_log_head_hash: b64(head?.hash ?? new Uint8Array(32)),
      });
    }
    if (url.endsWith('/api/hub/enrollments/redeem') && method === 'POST') {
      return Response.json({
        user: {
          id: user.id,
          username: live.username,
          root_public_key: b64(live.rootPublicKey),
          root_epoch: live.rootEpoch,
          kdf_params: kdfParams,
        },
        user_key_log: records.map((row) => ({
          seq: row.seq,
          bytes: b64(row.bytes),
          sig: b64(row.sig),
        })),
        node_certs: certs.map((cert) => ({
          node_id: cert.nodeId,
          user_id: cert.userId,
          admit_record_seq: cert.admitRecordSeq,
          certificate: b64(cert.certificateBytes),
          cert_sig: b64(cert.certSig),
          authorization: b64(cert.authorizationBytes),
          authorization_sig: b64(cert.authorizationSig),
          revoked_log_seq: cert.revokedLogSeq,
        })),
      });
    }
    if (url.endsWith('/api/auth/challenge') && method === 'POST') {
      return Response.json({
        challenge_id: 'ch-1',
        nonce: b64(randomBytes(32)),
        nodePk: b64(randomBytes(32)),
      });
    }
    if (url.endsWith('/api/auth/login') && method === 'POST') {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      opts?.logins?.push(JSON.parse(raw) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, expires_at: Date.now() + 60_000 }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-tmex-set-session': 'sid-join',
        },
      });
    }
    if (url.endsWith('/api/auth/keylog/head')) {
      const current = hub.keyLogStore.head(user.id);
      return Response.json({
        seq: Number(current?.seq ?? 0),
        hash: b64(current?.hash ?? new Uint8Array(32)),
        rootEpoch: live.rootEpoch,
        uid: user.id,
      });
    }
    if (url.endsWith('/api/auth/keylog') && method === 'POST') {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      opts?.posted?.push(JSON.parse(raw) as Record<string, unknown>);
      return Response.json({ ok: true, seq: records.length + 1 });
    }
    return new Response(`unhandled ${url}`, { status: 404 });
  };
}

describe('runHubJoin password branch', () => {
  test('appends admit-node to the hub key log', async () => {
    const hub = await openAuth('hub,node');
    const added = await runHubUserAdd(parseArgs([]), 'alice', {
      auth: hub,
      password: PASSWORD,
      log: () => undefined,
    });
    const user = hub.userStore.getById(added.userId);
    if (!user) throw new Error('missing hub user');
    const posted: Record<string, unknown>[] = [];
    const node = await openAuth('standalone');
    await runHubJoin(
      parseArgs(['hub', 'join', HUB, '--password', PASSWORD, '--name', 'studio']),
      HUB,
      {
        auth: node,
        skipRestart: true,
        fetcher: passwordJoinFetcher(hub, user, { posted }),
        log: () => undefined,
      }
    );
    expect(posted).toHaveLength(1);
    expect(decodeKeyLogRecord(decodeBase64url(String(posted[0]?.bytes))).type).toBe('admit-node');
    expect(node.userKeys.currentState(user.id).nodeCerts.size).toBeGreaterThan(0);
  });

  test('wires --totp into self-admit login', async () => {
    const hub = await openAuth('hub,node');
    const added = await runHubUserAdd(parseArgs([]), 'alice', {
      auth: hub,
      password: PASSWORD,
      log: () => undefined,
    });
    const user = hub.userStore.getById(added.userId);
    if (!user) throw new Error('missing hub user');
    const posted: Record<string, unknown>[] = [];
    const logins: Record<string, unknown>[] = [];
    const node = await openAuth('standalone');
    await runHubJoin(
      parseArgs([
        'hub',
        'join',
        HUB,
        '--password',
        PASSWORD,
        '--totp',
        '654321',
        '--name',
        'studio',
      ]),
      HUB,
      {
        auth: node,
        skipRestart: true,
        fetcher: passwordJoinFetcher(hub, user, { totpEnabled: true, posted, logins }),
        log: () => undefined,
      }
    );
    expect(posted).toHaveLength(1);
    expect((logins[0]?.totp as { code?: string } | undefined)?.code).toBe('654321');
  });

  test('passkey-only join finishes pending without admit-node', async () => {
    const hub = await openAuth('hub,node');
    const added = await runHubUserAdd(parseArgs([]), 'alice', {
      auth: hub,
      password: PASSWORD,
      log: () => undefined,
    });
    const user = hub.userStore.getById(added.userId);
    if (!user) throw new Error('missing hub user');
    const posted: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const node = await openAuth('standalone');
    const joined = await runHubJoin(
      parseArgs(['hub', 'join', HUB, '--password', PASSWORD, '--name', 'studio']),
      HUB,
      {
        auth: node,
        skipRestart: true,
        fetcher: passwordJoinFetcher(hub, user, { passkeySecondFactor: true, posted }),
        log: (message) => logs.push(message),
      }
    );
    expect(joined.admitPending).toBe(true);
    expect(posted).toEqual([]);
    expect(logs.some((line) => /waiting for approval|等待已登录的浏览器批准/i.test(line))).toBe(
      true
    );
  });
});
