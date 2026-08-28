import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import {
  JOIN_TOKEN_CHARS,
  createNodeCertificate,
  decodeJoinToken,
  encodeBase64url,
  nodeIdToHex,
  randomBytes,
  rootKeyFromSeed,
} from '../../../shared/src/auth';
import { parseArgs } from '../lib/args';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import {
  fakeLocalRedeem,
  pollHubEnrollment,
  pollHubNodesForCertificate,
  pollLocalEnrollmentRedeem,
  runEnroll,
} from './enroll';
import { runHubUserAdd } from './hub';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const parsed = parseArgs(['enroll', '--ttl', '10m']);
const handles: LocalAuthContext[] = [];

afterEach(() => {
  for (const ctx of handles.splice(0)) ctx.close();
});

describe('enroll', () => {
  test('path (a) creates a token and admits after a fake redeem', async () => {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
        TMEX_ROLES: 'hub,node',
        TMEX_HUB_PUBLIC_URL: 'https://hub.example',
      },
    });
    handles.push(auth);
    await runHubUserAdd(parsed, 'frank', {
      auth,
      password: 'enroll-pass-word',
      log: () => undefined,
    });
    const identity = await ensureNodeIdentity(auth.identityStore);
    let capturedToken = '';
    const result = await runEnroll(parsed, {
      auth,
      password: 'enroll-pass-word',
      log: (message) => {
        if (message.startsWith('join token: ')) {
          capturedToken = message.slice('join token: '.length);
        }
      },
      pollIntervalMs: 1,
      pollRedeemed: async () => {
        const user = auth.userStore.getByUsername('frank');
        if (!user) throw new Error('missing frank');
        const decoded = decodeJoinToken(capturedToken);
        const enrollPk = rootKeyFromSeed(decoded.enrollSk).publicKey;
        const realCert = createNodeCertificate(decoded.enrollSk, {
          uid: user.id,
          edPk: identity.edPublicKey,
          x25519Pk: identity.x25519PublicKey,
          enrollPk,
          now: Date.now(),
          nodeId: randomBytes(16),
        });
        await fakeLocalRedeem(auth, {
          enrollPk,
          certificateBytes: realCert.certificateBytes,
          certSig: realCert.certSig,
          name: 'joined',
        });
        return { certificateBytes: realCert.certificateBytes, certSig: realCert.certSig };
      },
    });
    expect(result.token).toHaveLength(JOIN_TOKEN_CHARS);
    expect(result.joinCommand).toContain('npx tmex-cli hub join');
    expect(result.admitted).toBe(true);
    const user = auth.userStore.getByUsername('frank');
    if (!user) throw new Error('missing frank');
    expect(auth.userStore.listCertsByUser(user.id).length).toBe(2);
  });

  test('SIGINT abort ends the wait loop and prints the Nodes page hint', async () => {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
        TMEX_ROLES: 'hub,node',
        TMEX_HUB_PUBLIC_URL: 'https://hub.example',
      },
    });
    handles.push(auth);
    await runHubUserAdd(parsed, 'gina', {
      auth,
      password: 'enroll-pass-word',
      log: () => undefined,
    });
    const controller = new AbortController();
    const logs: string[] = [];
    const result = await runEnroll(parsed, {
      auth,
      password: 'enroll-pass-word',
      log: (message) => logs.push(message),
      pollIntervalMs: 5,
      signal: controller.signal,
      pollRedeemed: async () => {
        controller.abort();
        return null;
      },
    });
    expect(result.admitted).toBe(false);
    expect(logs.some((line) => /Nodes page/i.test(line))).toBe(true);
  });

  test('hub poller reads certificate_b64 from authorizationJson after redeem', async () => {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
        TMEX_ROLES: 'hub,node',
        TMEX_HUB_PUBLIC_URL: 'https://hub.example',
      },
    });
    handles.push(auth);
    await runHubUserAdd(parsed, 'hank', {
      auth,
      password: 'enroll-pass-word',
      log: () => undefined,
    });
    const identity = await ensureNodeIdentity(auth.identityStore);
    const created = await runEnroll(parsed, {
      auth,
      password: 'enroll-pass-word',
      log: () => undefined,
      wait: false,
    });
    const decoded = decodeJoinToken(created.token);
    const enrollPk = rootKeyFromSeed(decoded.enrollSk).publicKey;
    const user = auth.userStore.getByUsername('hank');
    if (!user) throw new Error('missing hank');
    const realCert = createNodeCertificate(decoded.enrollSk, {
      uid: user.id,
      edPk: identity.edPublicKey,
      x25519Pk: identity.x25519PublicKey,
      enrollPk,
      now: Date.now(),
      nodeId: randomBytes(16),
    });
    await fakeLocalRedeem(auth, {
      enrollPk,
      certificateBytes: realCert.certificateBytes,
      certSig: realCert.certSig,
      name: 'joined',
    });
    const candidate = await pollLocalEnrollmentRedeem(auth, enrollPk);
    expect(candidate).not.toBeNull();
    expect(candidate?.certificateBytes).toEqual(realCert.certificateBytes);
    expect(candidate?.certSig).toEqual(realCert.certSig);
  });

  test('non-hub enroll sends totp when mode.totpEnabled', async () => {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
        TMEX_ROLES: 'node',
        TMEX_HUB_URL: '',
      },
    });
    handles.push(auth);
    await runHubUserAdd(parsed, 'ivy', {
      auth,
      password: 'enroll-pass-word',
      log: () => undefined,
    });
    let loginBody: Record<string, unknown> | null = null;
    let enrollmentCookie: string | null = null;
    const nonce = encodeBase64url(randomBytes(32));
    const nodePk = encodeBase64url(randomBytes(32));
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/auth/mode') {
          return Response.json({
            mode: 'mesh',
            nodeId: 'self',
            uid: auth.userStore.getByUsername('ivy')?.id,
            totpEnabled: true,
          });
        }
        if (url.pathname === '/api/auth/challenge') {
          return Response.json({ challenge_id: 'c1', nonce, nodePk });
        }
        if (url.pathname === '/api/auth/login') {
          loginBody = (await req.json()) as Record<string, unknown>;
          return new Response(JSON.stringify({ expires_at: Date.now() + 60_000 }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'set-cookie': 'tmex_s_self=sid-1; Path=/; HttpOnly; SameSite=Lax; Max-Age=60',
            },
          });
        }
        if (url.pathname === '/api/hub/enrollments' && req.method === 'POST') {
          enrollmentCookie = req.headers.get('cookie');
          return Response.json({ ok: true, id: 'enroll-1' }, { status: 201 });
        }
        return new Response('nope', { status: 404 });
      },
    });
    const hubUrl = `http://127.0.0.1:${server.port}`;
    auth.env.TMEX_HUB_URL = hubUrl;
    const result = await runEnroll(parsed, {
      auth,
      password: 'enroll-pass-word',
      totpCode: '123456',
      wait: false,
      log: () => undefined,
      fetcher: (input, init) => fetch(input, init),
      joinUrl: hubUrl,
    });
    server.stop();
    expect(result.admitted).toBe(false);
    expect(loginBody).toBeTruthy();
    const totp = loginBody?.totp as { code?: string; k_totp?: string } | undefined;
    expect(totp?.code).toBe('123456');
    expect(typeof totp?.k_totp).toBe('string');
    expect(totp?.k_totp?.length).toBeGreaterThan(10);
    expect(enrollmentCookie).toContain('tmex_s_self=sid-1');
  });

  test('non-hub enroll reads x-tmex-set-session when Set-Cookie is absent', async () => {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
        TMEX_ROLES: 'node',
        TMEX_HUB_URL: '',
      },
    });
    handles.push(auth);
    await runHubUserAdd(parsed, 'jade', {
      auth,
      password: 'enroll-pass-word',
      log: () => undefined,
    });
    let enrollmentCookie: string | null = null;
    const nonce = encodeBase64url(randomBytes(32));
    const nodePk = encodeBase64url(randomBytes(32));
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/auth/mode') {
          return Response.json({
            mode: 'mesh',
            nodeId: 'self',
            uid: auth.userStore.getByUsername('jade')?.id,
            totpEnabled: false,
          });
        }
        if (url.pathname === '/api/auth/challenge') {
          return Response.json({ challenge_id: 'c1', nonce, nodePk });
        }
        if (url.pathname === '/api/auth/login') {
          return new Response(JSON.stringify({ expires_at: Date.now() + 60_000 }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-tmex-set-session': 'header-sid;60',
            },
          });
        }
        if (url.pathname === '/api/hub/enrollments' && req.method === 'POST') {
          enrollmentCookie = req.headers.get('cookie');
          return Response.json({ ok: true, id: 'enroll-2' }, { status: 201 });
        }
        return new Response('nope', { status: 404 });
      },
    });
    const hubUrl = `http://127.0.0.1:${server.port}`;
    auth.env.TMEX_HUB_URL = hubUrl;
    const result = await runEnroll(parsed, {
      auth,
      password: 'enroll-pass-word',
      wait: false,
      log: () => undefined,
      fetcher: (input, init) => fetch(input, init),
      joinUrl: hubUrl,
    });
    server.stop();
    expect(result.admitted).toBe(false);
    expect(enrollmentCookie).toContain('tmex_s_self=header-sid');
  });

  test('pollHubNodesForCertificate matches enroll_pk on hub node list', async () => {
    const enrollSk = randomBytes(32);
    const enrollPk = rootKeyFromSeed(enrollSk).publicKey;
    const wanted = createNodeCertificate(enrollSk, {
      uid: 'user-1',
      edPk: randomBytes(32),
      x25519Pk: randomBytes(32),
      enrollPk,
      now: Date.now(),
      nodeId: randomBytes(16),
    });
    const otherSk = randomBytes(32);
    const other = createNodeCertificate(otherSk, {
      uid: 'user-1',
      edPk: randomBytes(32),
      x25519Pk: randomBytes(32),
      enrollPk: rootKeyFromSeed(otherSk).publicKey,
      now: Date.now(),
      nodeId: randomBytes(16),
    });
    const result = await pollHubNodesForCertificate({
      baseUrl: 'https://hub.example',
      cookieHeader: 'tmex_s_self=x',
      enrollPk,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            nodes: [
              {
                id: 'aa',
                certificate: encodeBase64url(other.certificateBytes),
                cert_sig: encodeBase64url(other.certSig),
              },
              {
                id: 'bb',
                certificate: encodeBase64url(wanted.certificateBytes),
                cert_sig: encodeBase64url(wanted.certSig),
              },
            ],
          })
        ),
    });
    expect(result?.certificateBytes).toEqual(wanted.certificateBytes);
    expect(result?.certSig).toEqual(wanted.certSig);
  });

  test('pollHubEnrollment surfaces already_admitted and the admitted cert', async () => {
    const enrollSk = randomBytes(32);
    const enrollPk = rootKeyFromSeed(enrollSk).publicKey;
    const admitted = createNodeCertificate(enrollSk, {
      uid: 'user-1',
      edPk: randomBytes(32),
      x25519Pk: randomBytes(32),
      enrollPk,
      now: Date.now(),
      nodeId: randomBytes(16),
    });
    const result = await pollHubEnrollment({
      baseUrl: 'https://hub.example',
      cookieHeader: 'tmex_s_self=x',
      enrollmentId: 'enroll-9',
      fetcher: async (input) => {
        expect(String(input)).toBe('https://hub.example/api/hub/enrollments/enroll-9');
        return new Response(
          JSON.stringify({
            status: 'redeemed',
            enroll_pk: encodeBase64url(enrollPk),
            certificate: encodeBase64url(admitted.certificateBytes),
            cert_sig: encodeBase64url(admitted.certSig),
            node_id: 'aa'.repeat(16),
            already_admitted: true,
          })
        );
      },
    });
    expect(result?.alreadyAdmitted).toBe(true);
    expect(result?.certificateBytes).toEqual(admitted.certificateBytes);
    expect(result?.certSig).toEqual(admitted.certSig);
  });

  test('skips a second admit and logs already admitted for an existing node_id', async () => {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
        TMEX_ROLES: 'hub,node',
        TMEX_HUB_PUBLIC_URL: 'https://hub.example',
      },
    });
    handles.push(auth);
    await runHubUserAdd(parsed, 'frank', {
      auth,
      password: 'enroll-pass-word',
      log: () => undefined,
    });
    const identity = await ensureNodeIdentity(auth.identityStore);
    const user = auth.userStore.getByUsername('frank');
    if (!user) throw new Error('missing frank');
    const existing = auth.userStore.getCert(identity.nodeIdHex);
    if (!existing) throw new Error('missing self cert');
    const certsBefore = auth.userStore.listCertsByUser(user.id).length;
    const logs: string[] = [];
    const result = await runEnroll(parsed, {
      auth,
      password: 'enroll-pass-word',
      log: (message) => logs.push(message),
      pollIntervalMs: 1,
      pollRedeemed: async () => ({
        certificateBytes: existing.certificateBytes,
        certSig: existing.certSig,
      }),
    });
    expect(result.admitted).toBe(true);
    expect(logs).toContain('already admitted');
    expect(logs).not.toContain('node admitted');
    expect(auth.userStore.listCertsByUser(user.id)).toHaveLength(certsBefore);
  });

  test('skips admit-node when hub reports already_admitted even without a local cert', async () => {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
        TMEX_ROLES: 'hub,node',
        TMEX_HUB_PUBLIC_URL: 'https://hub.example',
      },
    });
    handles.push(auth);
    await runHubUserAdd(parsed, 'frank', {
      auth,
      password: 'enroll-pass-word',
      log: () => undefined,
    });
    const identity = await ensureNodeIdentity(auth.identityStore);
    const user = auth.userStore.getByUsername('frank');
    if (!user) throw new Error('missing frank');
    const certsBefore = auth.userStore.listCertsByUser(user.id).length;
    let capturedToken = '';
    const logs: string[] = [];
    const result = await runEnroll(parsed, {
      auth,
      password: 'enroll-pass-word',
      log: (message) => {
        logs.push(message);
        if (message.startsWith('join token: ')) {
          capturedToken = message.slice('join token: '.length);
        }
      },
      pollIntervalMs: 1,
      pollRedeemed: async () => {
        const decoded = decodeJoinToken(capturedToken);
        const enrollPk = rootKeyFromSeed(decoded.enrollSk).publicKey;
        const remoteCert = createNodeCertificate(decoded.enrollSk, {
          uid: user.id,
          edPk: identity.edPublicKey,
          x25519Pk: identity.x25519PublicKey,
          enrollPk,
          now: Date.now(),
          nodeId: randomBytes(16),
        });
        expect(auth.userStore.getCert(nodeIdToHex(remoteCert.nodeId))).toBeNull();
        return {
          certificateBytes: remoteCert.certificateBytes,
          certSig: remoteCert.certSig,
          alreadyAdmitted: true,
        };
      },
    });
    expect(result.admitted).toBe(true);
    expect(logs).toContain('already admitted');
    expect(logs).not.toContain('node admitted');
    expect(auth.userStore.listCertsByUser(user.id)).toHaveLength(certsBefore);
  });

  test('surfaces a key-log rejection instead of printing node admitted', async () => {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
        TMEX_ROLES: 'hub,node',
        TMEX_HUB_PUBLIC_URL: 'https://hub.example',
      },
    });
    handles.push(auth);
    await runHubUserAdd(parsed, 'frank', {
      auth,
      password: 'enroll-pass-word',
      log: () => undefined,
    });
    const identity = await ensureNodeIdentity(auth.identityStore);
    const logs: string[] = [];
    await expect(
      runEnroll(parsed, {
        auth,
        password: 'enroll-pass-word',
        log: (message) => logs.push(message),
        pollIntervalMs: 1,
        pollRedeemed: async () => {
          const user = auth.userStore.getByUsername('frank');
          if (!user) throw new Error('missing frank');
          const realCert = createNodeCertificate(randomBytes(32), {
            uid: user.id,
            edPk: identity.edPublicKey,
            x25519Pk: identity.x25519PublicKey,
            enrollPk: randomBytes(32),
            now: Date.now(),
            nodeId: randomBytes(16),
          });
          return {
            certificateBytes: realCert.certificateBytes,
            certSig: new Uint8Array(64),
          };
        },
      })
    ).rejects.toThrow(/admit-node failed: /);
    expect(logs).not.toContain('node admitted');
    expect(logs).not.toContain('already admitted');
  });
});
