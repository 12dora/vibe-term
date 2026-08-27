import { describe, expect, test } from 'bun:test';
import {
  DELEGATION_TTL_MS,
  buildLogin,
  createDelegation,
  decodeBase64url,
  encodeBase64url,
  encodeClearTotpPayload,
  encodeLogin,
  encodeSetTotpPayload,
  encryptTotpSecret,
  generateEd25519KeyPair,
  signLogin,
  totpCode,
} from '@tmex/shared/auth';
import type { LinkSession } from '@tmex/shared/link';
import { ChallengeStore } from '../auth/challenge-store';
import { KeyLogStore } from '../auth/key-log-store';
import { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import {
  type MeshRtcDeps,
  type OpenedWsStream,
  type PeerLinkProvider,
  type StreamOpener,
  setMeshRequestContext,
} from './mesh-deps';
import { MeshHttpRuntime } from './mesh-http';
import { NodeUnreachableError } from './types';

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export const NODE_ID = 'aa'.repeat(16);
// biome-ignore lint/suspicious/noExportsInTest: shared harness
export const NODE_PK = Uint8Array.from({ length: 32 }, () => 9);
// biome-ignore lint/suspicious/noExportsInTest: shared harness
export const PASSWORD = 'tmex-test';

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export class FakePeers implements PeerLinkProvider {
  readonly links = new Map<string, LinkSession>();
  readonly reach = new Map<string, 'lan' | 'relay' | null>();
  readonly listeners = new Set<
    (e: { nodeId: string; status: 'online' | 'offline' | 'revoked' }) => void
  >();

  async getLink(nodeId: string): Promise<LinkSession> {
    const link = this.links.get(nodeId);
    if (!link) throw new NodeUnreachableError(nodeId);
    return link;
  }

  listReach(): Map<string, 'lan' | 'relay' | null> {
    return this.reach;
  }

  onNodeEvent(
    cb: (e: { nodeId: string; status: 'online' | 'offline' | 'revoked' }) => void
  ): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(event: { nodeId: string; status: 'online' | 'offline' | 'revoked' }): void {
    for (const cb of this.listeners) cb(event);
  }
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export class FakeWs implements OpenedWsStream {
  readonly sent: Uint8Array[] = [];
  private msg: Array<(b: Uint8Array) => void> = [];
  private closed: Array<(info: { code?: number; reason?: string }) => void> = [];

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.msg.push(cb);
  }
  onClose(cb: (info: { code?: number; reason?: string }) => void): void {
    this.closed.push(cb);
  }
  close(code?: number, reason?: string): void {
    for (const cb of this.closed) cb({ code, reason });
  }
  pushFromRemote(bytes: Uint8Array): void {
    for (const cb of this.msg) cb(bytes);
  }
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export class FakeStreams implements StreamOpener {
  lastOpen: {
    path: string;
    headers: Record<string, string>;
    auth: string | null;
    method: string;
  } | null = null;
  nextResponse: Response = new Response('ok');
  lastWs: FakeWs | null = null;
  wsAuth: string | null = null;

  async openHttpStream(
    _link: LinkSession,
    open: {
      method: string;
      path: string;
      query: string;
      headers: Record<string, string>;
      origin: string;
      auth: string | null;
    },
    _body: ReadableStream<Uint8Array> | null,
    _signal: AbortSignal
  ): Promise<Response> {
    this.lastOpen = {
      path: open.path,
      headers: open.headers,
      auth: open.auth,
      method: open.method,
    };
    return this.nextResponse;
  }

  async openWsStream(_link: LinkSession, auth: string): Promise<OpenedWsStream> {
    this.wsAuth = auth;
    this.lastWs = new FakeWs();
    return this.lastWs;
  }
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export const dummyServer = { upgrade: () => true };

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export async function bootMesh(options?: {
  roles?: { hub: boolean; node: boolean };
  now?: () => number;
  peers?: FakePeers;
  streams?: FakeStreams;
  rtc?: MeshRtcDeps;
}) {
  const { db, close } = createMigratedAuthDb();
  const userStore = new UserStore(db);
  const keyLogStore = new KeyLogStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const keyLogService = new UserKeyService({ db, userStore, keyLogStore, nodeSessionStore });
  const boot = await keyLogService.bootstrapUser({ username: 'alice', password: PASSWORD });
  const challengeStore = new ChallengeStore({ now: options?.now });
  const peers = options?.peers ?? new FakePeers();
  const streams = options?.streams ?? new FakeStreams();
  const published: Array<{ bytes: Uint8Array; sig: Uint8Array }> = [];
  const runtime = new MeshHttpRuntime({
    roles: options?.roles ?? { hub: false, node: true },
    nodeId: NODE_ID,
    nodePk: NODE_PK,
    userStore,
    keyLogService,
    challengeStore,
    nodeSessionStore,
    peers,
    streams,
    publisher: {
      publish(record) {
        published.push(record);
      },
    },
    rtc: options?.rtc,
    now: options?.now,
    primaryUserId: boot.userId,
  });
  return {
    close,
    runtime,
    userStore,
    keyLogService,
    nodeSessionStore,
    challengeStore,
    peers,
    streams,
    published,
    boot,
  };
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export async function call(
  runtime: MeshHttpRuntime,
  url: string,
  init?: RequestInit & { via?: string; clientIp?: string; authSid?: string }
): Promise<Response> {
  const req = new Request(url, init);
  if (init?.via || init?.clientIp || init?.authSid) {
    setMeshRequestContext(req, {
      via: init.via ?? 'self',
      clientIp: init.clientIp,
      auth: init.authSid,
    });
  }
  const res = await runtime.handleRequest(req, dummyServer);
  if (res == null) {
    throw new Error(`unhandled ${url}`);
  }
  return res;
}

// biome-ignore lint/suspicious/noExportsInTest: shared harness
export async function challengeAndLogin(
  runtime: MeshHttpRuntime,
  boot: { userId: string; rootKey: Parameters<typeof createDelegation>[0] },
  tweak?: {
    entry?: string;
    target?: string;
    targetPk?: Uint8Array;
    badSig?: boolean;
    totp?: { code: string; k_totp: string };
    via?: string;
    reuseChallenge?: { challenge_id: string; nonce: Uint8Array };
    issuedAt?: number;
    clientIp?: string;
  }
) {
  const sess = generateEd25519KeyPair();
  const issuedAt = tweak?.issuedAt ?? Date.now();
  const del = createDelegation(boot.rootKey, {
    uid: boot.userId,
    sessPk: sess.publicKey,
    now: issuedAt,
  });
  let challengeId: string;
  let nonce: Uint8Array;
  if (tweak?.reuseChallenge) {
    challengeId = tweak.reuseChallenge.challenge_id;
    nonce = tweak.reuseChallenge.nonce;
  } else {
    const ch = await call(runtime, 'http://localhost/api/auth/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid: boot.userId }),
      via: tweak?.via,
      clientIp: tweak?.clientIp,
    });
    const body = (await ch.json()) as { challenge_id: string; nonce: string };
    challengeId = body.challenge_id;
    nonce = decodeBase64url(body.nonce);
  }
  const login = buildLogin({
    challengeId,
    nonce,
    target: tweak?.target ?? NODE_ID,
    targetPk: tweak?.targetPk ?? NODE_PK,
    uid: boot.userId,
    entry: tweak?.entry ?? tweak?.via ?? 'self',
  });
  let sig = signLogin(sess.secretKey, login);
  if (tweak?.badSig) {
    sig = new Uint8Array(sig);
    sig[0] = (sig[0] ?? 0) ^ 0xff;
  }
  const res = await call(runtime, 'http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(sig),
      delegation: encodeBase64url(del.bytes),
      delegation_sig: encodeBase64url(del.sig),
      ...(tweak?.totp ? { totp: tweak.totp } : {}),
    }),
    via: tweak?.via,
    clientIp: tweak?.clientIp,
  });
  return { res, challengeId, nonce, del };
}

describe('auth-routes', () => {
  test('GET /api/auth/mode mesh + standalone none', async () => {
    const mesh = await bootMesh();
    try {
      const res = await call(mesh.runtime, 'http://localhost/api/auth/mode', {
        headers: { origin: 'http://localhost:19663' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        mode: string;
        nodeId: string;
        uid: string;
        username: string;
        kdfParams: { salt: string; memory_kib: number };
        passkeysForThisOrigin: boolean;
        passkeyAvailable: boolean;
        totpEnabled: boolean;
      };
      expect(body.mode).toBe('mesh');
      expect(body.nodeId).toBe(NODE_ID);
      expect(body.username).toBe('alice');
      expect(body.uid).toBe(mesh.boot.userId);
      expect(body.kdfParams.memory_kib).toBe(65536);
      expect(body.passkeysForThisOrigin).toBe(false);
      expect(body.passkeyAvailable).toBe(true);
      expect(body.totpEnabled).toBe(false);
    } finally {
      mesh.close();
    }

    const standalone = await bootMesh({ roles: { hub: false, node: false } });
    try {
      const res = await call(standalone.runtime, 'http://localhost/api/auth/mode');
      const body = (await res.json()) as { mode: string };
      expect(body.mode).toBe('none');
    } finally {
      standalone.close();
    }
  });

  test('login happy path sets cookie + x-tmex-set-session', async () => {
    const mesh = await bootMesh();
    try {
      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sid: string; expires_at: number };
      expect(body.sid.length).toBeGreaterThan(10);
      expect(body.expires_at).toBeGreaterThan(Date.now());
      expect(res.headers.get('x-tmex-set-session')?.startsWith(`${body.sid};`)).toBe(true);
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('tmex_s_self=');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
    } finally {
      mesh.close();
    }
  });

  test('login via remote entry does not Set-Cookie, only x-tmex-set-session', async () => {
    const mesh = await bootMesh();
    try {
      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot, {
        via: 'entry-node',
        entry: 'entry-node',
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('x-tmex-set-session')).toBeTruthy();
    } finally {
      mesh.close();
    }
  });

  test('failure codes: consumed challenge, wrong entry, wrong target_pk, expired delegation, bad sig', async () => {
    const mesh = await bootMesh();
    try {
      const first = await challengeAndLogin(mesh.runtime, mesh.boot);
      expect(first.res.status).toBe(200);
      const replay = await challengeAndLogin(mesh.runtime, mesh.boot, {
        reuseChallenge: { challenge_id: first.challengeId, nonce: first.nonce },
      });
      expect(replay.res.status).toBe(401);
      expect((await replay.res.json()).code).toBe('CHALLENGE_CONSUMED');

      const entry = await challengeAndLogin(mesh.runtime, mesh.boot, { entry: 'other-entry' });
      expect((await entry.res.json()).code).toBe('ENTRY_MISMATCH');

      const pk = await challengeAndLogin(mesh.runtime, mesh.boot, {
        targetPk: new Uint8Array(32).fill(1),
      });
      expect((await pk.res.json()).code).toBe('TARGET_MISMATCH');

      const expired = await challengeAndLogin(mesh.runtime, mesh.boot, {
        issuedAt: Date.now() - DELEGATION_TTL_MS - 2000,
      });
      expect((await expired.res.json()).code).toBe('DELEGATION_EXPIRED');

      const bad = await challengeAndLogin(mesh.runtime, mesh.boot, { badSig: true });
      expect((await bad.res.json()).code).toBe('BAD_SIGNATURE');
    } finally {
      mesh.close();
    }
  });

  test('wrong TOTP rejected; missing TOTP required when enabled', async () => {
    const mesh = await bootMesh();
    try {
      const { deriveSeed, deriveTotpKey } = await import('@tmex/shared/auth');
      const { kdfParamsFromJson } = await import('../auth/user-key-service');
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const secret = new Uint8Array(20).fill(7);
      const user = mesh.userStore.getById(mesh.boot.userId);
      if (!user) throw new Error('missing user');
      const params = kdfParamsFromJson(user.kdfParamsJson);
      const seed = await deriveSeed(PASSWORD, params);
      const kTotp = deriveTotpKey(seed, mesh.boot.userId, state.rootEpoch);
      const payload = await encryptTotpSecret(kTotp, secret, {
        uid: mesh.boot.userId,
        root_epoch: state.rootEpoch,
        seq: state.head.seq + 1n,
      });
      const applied = await mesh.keyLogService.signAndApply(mesh.boot.userId, mesh.boot.rootKey, {
        type: 'set-totp',
        payload: encodeSetTotpPayload(payload),
      });
      expect(applied.ok).toBe(true);

      const missing = await challengeAndLogin(mesh.runtime, mesh.boot);
      expect((await missing.res.json()).code).toBe('TOTP_REQUIRED');

      const wrong = await challengeAndLogin(mesh.runtime, mesh.boot, {
        totp: { code: '000000', k_totp: encodeBase64url(kTotp) },
      });
      expect((await wrong.res.json()).code).toBe('TOTP_INVALID');

      const code = totpCode(secret, Math.floor(Date.now() / 1000));
      const ok = await challengeAndLogin(mesh.runtime, mesh.boot, {
        totp: { code, k_totp: encodeBase64url(kTotp) },
      });
      expect(ok.res.status).toBe(200);
    } finally {
      mesh.close();
    }
  });

  test('rate limit 10 failures per uid / ip → 429', async () => {
    const mesh = await bootMesh();
    try {
      for (let i = 0; i < 10; i++) {
        const { res } = await challengeAndLogin(mesh.runtime, mesh.boot, {
          badSig: true,
          clientIp: '10.0.0.9',
        });
        expect(res.status).toBe(401);
      }
      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot, {
        badSig: true,
        clientIp: '10.0.0.9',
      });
      expect(res.status).toBe(429);
      expect((await res.json()).code).toBe('RATE_LIMITED');
    } finally {
      mesh.close();
    }
  });

  test('passkey register/options requires session; login/options returns publicKey options', async () => {
    const mesh = await bootMesh();
    try {
      const denied = await call(
        mesh.runtime,
        'http://localhost/api/auth/passkey/register/options',
        {
          method: 'POST',
        }
      );
      expect(denied.status).toBe(401);

      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { sid } = (await res.json()) as { sid: string };
      const opts = await call(mesh.runtime, 'http://localhost/api/auth/passkey/register/options', {
        method: 'POST',
        headers: { cookie: `tmex_s_self=${sid}`, origin: 'http://localhost:19663' },
      });
      expect(opts.status).toBe(200);
      const body = (await opts.json()) as {
        challenge: string;
        rp: { id: string };
        challenge_id: string;
      };
      expect(body.rp.id).toBe('localhost');
      expect(body.challenge_id).toBeTruthy();

      const { encodeDelegation } = await import('@tmex/shared/auth');
      const sess = generateEd25519KeyPair();
      const del = createDelegation(mesh.boot.rootKey, {
        uid: mesh.boot.userId,
        sessPk: sess.publicKey,
        now: Date.now(),
      });
      const loginOpts = await call(
        mesh.runtime,
        'http://localhost/api/auth/passkey/login/options',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:19663' },
          body: JSON.stringify({
            uid: mesh.boot.userId,
            delegation: encodeBase64url(encodeDelegation(del.delegation)),
          }),
        }
      );
      expect(loginOpts.status).toBe(200);
      const lo = (await loginOpts.json()) as { challenge: string; userVerification: string };
      expect(lo.userVerification).toBe('required');
      expect(lo.challenge).toBeTruthy();
    } finally {
      mesh.close();
    }
  });

  test('logout revokes sessions and clears cookie', async () => {
    const mesh = await bootMesh();
    try {
      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const body = (await res.json()) as { sid: string };
      const out = await call(mesh.runtime, 'http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { cookie: `tmex_s_self=${body.sid}` },
      });
      expect(out.status).toBe(200);
      expect(out.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
      expect(
        mesh.nodeSessionStore.verify(body.sid, { viaNodeId: 'self', now: Date.now() }).ok
      ).toBe(false);
    } finally {
      mesh.close();
    }
  });

  test('keylog apply forwards to publisher; fork → 409', async () => {
    const mesh = await bootMesh();
    try {
      const { res } = await challengeAndLogin(mesh.runtime, mesh.boot);
      const { sid } = (await res.json()) as { sid: string };
      const { buildKeyLogRecord, encodeKeyLogRecord, signKeyLogRecordWithRoot } = await import(
        '@tmex/shared/auth'
      );
      const state = mesh.keyLogService.currentState(mesh.boot.userId);
      const recA = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'clear-totp',
        payload: encodeClearTotpPayload(),
        signer: 'root',
        credential_id: null,
      });
      const bytesA = encodeKeyLogRecord(recA);
      const sigA = signKeyLogRecordWithRoot(mesh.boot.rootKey, bytesA);
      const ok = await call(mesh.runtime, 'http://localhost/api/auth/keylog', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tmex_s_self=${sid}`,
        },
        body: JSON.stringify({
          bytes: encodeBase64url(bytesA),
          sig: encodeBase64url(sigA),
        }),
      });
      expect(ok.status).toBe(200);
      expect(mesh.published).toHaveLength(1);

      const recB = buildKeyLogRecord(state.head, state.rootEpoch, {
        uid: mesh.boot.userId,
        type: 'set-totp',
        payload: encodeSetTotpPayload({
          alg: 'A256GCM',
          nonce: new Uint8Array(12).fill(1),
          ciphertext: new Uint8Array(4).fill(2),
          tag: new Uint8Array(16).fill(3),
        }),
        signer: 'root',
        credential_id: null,
      });
      const bytesB = encodeKeyLogRecord(recB);
      const sigB = signKeyLogRecordWithRoot(mesh.boot.rootKey, bytesB);
      const forkRes = await call(mesh.runtime, 'http://localhost/api/auth/keylog', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `tmex_s_self=${sid}`,
        },
        body: JSON.stringify({
          bytes: encodeBase64url(bytesB),
          sig: encodeBase64url(sigB),
        }),
      });
      expect(forkRes.status).toBe(409);
      expect((await forkRes.json()).code).toBe('KEY_LOG_FORK');
    } finally {
      mesh.close();
    }
  });
});
