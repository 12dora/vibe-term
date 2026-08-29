import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HubTrustStore } from '../../../../apps/gateway/src/auth/hub-trust-store';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import {
  JOIN_TOKEN_CHARS,
  createEnrollment,
  createNodeCertificate,
  decodeBase64url,
  decodeCertificate,
  deriveSeed,
  encodeBase64url,
  encodeJoinToken,
  generateX25519KeyPair,
  nodeIdToHex,
  randomBytes,
  rootKeyFromSeed,
} from '../../../shared/src/auth';
import { parseArgs } from '../lib/args';
import { readEnvFile } from '../lib/env-file';
import { assertHubJoinUrl } from '../lib/hub-client';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { MAX_CA_RESPONSE_BYTES } from '../lib/pem';
import { createCa, issueLeaf, spkiFingerprint } from '../tls/cert-authority';
import {
  NODE_REVOKED_REJOIN_ERROR,
  performHubJoin,
  runHubJoin,
  runHubLeave,
  runHubUserAdd,
} from './hub';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const handles: LocalAuthContext[] = [];
const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  for (const ctx of handles.splice(0)) ctx.close();
  for (const server of servers.splice(0)) server.stop();
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

describe('hub join url rules', () => {
  test('rejects http unless insecure-local on loopback', () => {
    expect(() => assertHubJoinUrl('http://example.com')).toThrow(/https/);
    expect(() => assertHubJoinUrl('http://127.0.0.1:9')).toThrow(/https/);
    expect(assertHubJoinUrl('http://127.0.0.1:9', true, 'test').hostname).toBe('127.0.0.1');
    expect(assertHubJoinUrl('https://hub.example').protocol).toBe('https:');
    expect(() => assertHubJoinUrl('http://127.0.0.1:9', true, 'production')).toThrow(
      /NODE_ENV=production/
    );
  });

  test('runHubJoin rejects remote http', async () => {
    const node = await openAuth('standalone');
    await expect(
      runHubJoin(
        parseArgs(['hub', 'join', 'http://example.com', '--token', 'x'.repeat(JOIN_TOKEN_CHARS)]),
        'http://example.com',
        {
          auth: node,
          skipRestart: true,
          log: () => undefined,
        }
      )
    ).rejects.toThrow(/https/);
  });
});

describe('hub join against fake hub', () => {
  test('verifies chain and rejects root mismatch', async () => {
    const hub = await openAuth('hub,node');
    const added = await runHubUserAdd(parseArgs([]), 'hubuser', {
      auth: hub,
      password: 'hub-pass-word',
      log: () => undefined,
    });
    const user = hub.userStore.getById(added.userId);
    if (!user) throw new Error('missing hub user');
    const state = hub.userKeys.currentState(user.id);
    const enrollment = await createEnrollment(
      rootKeyFromSeed(await deriveSeed('hub-pass-word', state.kdfParams)),
      {
        uid: user.id,
        rootEpoch: state.rootEpoch,
        now: Date.now(),
      }
    );
    const token = encodeJoinToken(enrollment.enrollSk, state.rootPublicKey, state.head.hash);
    const records = hub.keyLogStore.list(user.id);
    const certs = hub.userStore.listCertsByUser(user.id);

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/auth/mode') {
          return Response.json({
            mode: 'mesh',
            nodeId: 'self',
            uid: user.id,
            username: user.username,
          });
        }
        if (url.pathname === '/api/hub/enrollments/redeem' && req.method === 'POST') {
          return Response.json({
            user: {
              id: user.id,
              username: user.username,
              root_public_key: encodeBase64url(user.rootPublicKey),
              root_epoch: user.rootEpoch,
              kdf_params: JSON.parse(user.kdfParamsJson),
            },
            user_key_log: records.map((row) => ({
              seq: row.seq,
              bytes: encodeBase64url(row.bytes),
              sig: encodeBase64url(row.sig),
            })),
            node_certs: certs.map((cert) => ({
              node_id: cert.nodeId,
              user_id: cert.userId,
              admit_record_seq: cert.admitRecordSeq,
              certificate: encodeBase64url(cert.certificateBytes),
              cert_sig: encodeBase64url(cert.certSig),
              authorization: encodeBase64url(cert.authorizationBytes),
              authorization_sig: encodeBase64url(cert.authorizationSig),
              revoked_log_seq: cert.revokedLogSeq,
            })),
          });
        }
        return new Response('nope', { status: 404 });
      },
    });
    servers.push(server);
    const hubUrl = `http://127.0.0.1:${server.port}`;

    const node = await openAuth('standalone');
    const logs: string[] = [];
    const joined = await runHubJoin(
      parseArgs(['hub', 'join', hubUrl, '--token', token, '--insecure-local']),
      hubUrl,
      {
        auth: node,
        skipRestart: true,
        insecureLocal: true,
        log: (message) => logs.push(message),
      }
    );
    expect(joined.userId).toBe(user.id);
    expect(logs.some((line) => /TMEX_PEER_PORT/.test(line) && /firewall/i.test(line))).toBe(true);
    const nodeUser = node.userStore.getById(user.id);
    expect(nodeUser).toBeTruthy();
    expect(node.keyLogStore.list(user.id).length).toBe(records.length);
    const projected = hub.userStore.listCertsByUser(user.id);
    const joinedCerts = node.userStore.listCertsByUser(user.id);
    expect(joinedCerts.length).toBe(projected.length);
    expect(joinedCerts[0]?.nodeId).toBe(projected[0]?.nodeId);
    expect(joinedCerts[0]?.certificateBytes).toEqual(projected[0]?.certificateBytes);
    const identity = await node.identityStore.load();
    expect(identity?.hubUrl).toBe(hubUrl);
    expect(identity?.userId).toBe(user.id);

    await runHubLeave(parseArgs(['hub', 'leave']), {
      auth: node,
      skipRestart: true,
      log: () => undefined,
    });
    expect(await node.identityStore.load()).toBeNull();
    expect(node.userStore.getById(user.id)).toBeNull();

    const badRoot = encodeJoinToken(enrollment.enrollSk, randomBytes(32), state.head.hash);
    const node2 = await openAuth('standalone');
    await expect(
      runHubJoin(
        parseArgs(['hub', 'join', hubUrl, '--token', badRoot, '--insecure-local']),
        hubUrl,
        {
          auth: node2,
          skipRestart: true,
          insecureLocal: true,
          log: () => undefined,
        }
      )
    ).rejects.toThrow(/root|key log rejected/);
  });

  test('tampered node_certs is rejected and not written', async () => {
    const hub = await openAuth('hub,node');
    const added = await runHubUserAdd(parseArgs([]), 'hubuser', {
      auth: hub,
      password: 'hub-pass-word',
      log: () => undefined,
    });
    const user = hub.userStore.getById(added.userId);
    if (!user) throw new Error('missing hub user');
    const state = hub.userKeys.currentState(user.id);
    const enrollment = await createEnrollment(
      rootKeyFromSeed(await deriveSeed('hub-pass-word', state.kdfParams)),
      { uid: user.id, rootEpoch: state.rootEpoch, now: Date.now() }
    );
    const token = encodeJoinToken(enrollment.enrollSk, state.rootPublicKey, state.head.hash);
    const records = hub.keyLogStore.list(user.id);
    const certs = hub.userStore.listCertsByUser(user.id);
    const tampered = certs.map((cert, index) => ({
      node_id: cert.nodeId,
      user_id: cert.userId,
      admit_record_seq: cert.admitRecordSeq,
      certificate:
        index === 0
          ? encodeBase64url(randomBytes(cert.certificateBytes.length))
          : encodeBase64url(cert.certificateBytes),
      cert_sig: encodeBase64url(cert.certSig),
      authorization: encodeBase64url(cert.authorizationBytes),
      authorization_sig: encodeBase64url(cert.authorizationSig),
      revoked_log_seq: cert.revokedLogSeq,
    }));

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/auth/mode') {
          return Response.json({
            mode: 'mesh',
            nodeId: 'self',
            uid: user.id,
            username: user.username,
          });
        }
        if (url.pathname === '/api/hub/enrollments/redeem' && req.method === 'POST') {
          return Response.json({
            user: {
              id: user.id,
              username: user.username,
              root_public_key: encodeBase64url(user.rootPublicKey),
              root_epoch: user.rootEpoch,
              kdf_params: JSON.parse(user.kdfParamsJson),
            },
            user_key_log: records.map((row) => ({
              seq: row.seq,
              bytes: encodeBase64url(row.bytes),
              sig: encodeBase64url(row.sig),
            })),
            node_certs: tampered,
          });
        }
        return new Response('nope', { status: 404 });
      },
    });
    servers.push(server);
    const hubUrl = `http://127.0.0.1:${server.port}`;
    const node = await openAuth('standalone');
    await expect(
      runHubJoin(parseArgs(['hub', 'join', hubUrl, '--token', token, '--insecure-local']), hubUrl, {
        auth: node,
        skipRestart: true,
        insecureLocal: true,
        log: () => undefined,
      })
    ).rejects.toThrow(/node_certs mismatch/);
    expect(node.userStore.listCertsByUser(user.id)).toEqual([]);
    expect(node.userStore.getById(user.id)).toBeNull();
  });

  test('forged uid from /api/auth/mode is rejected before commit', async () => {
    const hub = await openAuth('hub,node');
    const added = await runHubUserAdd(parseArgs([]), 'hubuser', {
      auth: hub,
      password: 'hub-pass-word',
      log: () => undefined,
    });
    const user = hub.userStore.getById(added.userId);
    if (!user) throw new Error('missing hub user');
    const state = hub.userKeys.currentState(user.id);
    const enrollment = await createEnrollment(
      rootKeyFromSeed(await deriveSeed('hub-pass-word', state.kdfParams)),
      { uid: user.id, rootEpoch: state.rootEpoch, now: Date.now() }
    );
    const token = encodeJoinToken(enrollment.enrollSk, state.rootPublicKey, state.head.hash);
    const records = hub.keyLogStore.list(user.id);
    const certs = hub.userStore.listCertsByUser(user.id);
    const forgedUid = 'forged-uid-from-mode';

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/auth/mode') {
          return Response.json({
            mode: 'mesh',
            nodeId: 'self',
            uid: forgedUid,
            username: user.username,
          });
        }
        if (url.pathname === '/api/hub/enrollments/redeem' && req.method === 'POST') {
          return Response.json({
            user: {
              id: user.id,
              username: user.username,
              root_public_key: encodeBase64url(user.rootPublicKey),
              root_epoch: user.rootEpoch,
              kdf_params: JSON.parse(user.kdfParamsJson),
            },
            user_key_log: records.map((row) => ({
              seq: row.seq,
              bytes: encodeBase64url(row.bytes),
              sig: encodeBase64url(row.sig),
            })),
            node_certs: certs.map((cert) => ({
              node_id: cert.nodeId,
              user_id: cert.userId,
              admit_record_seq: cert.admitRecordSeq,
              certificate: encodeBase64url(cert.certificateBytes),
              cert_sig: encodeBase64url(cert.certSig),
              authorization: encodeBase64url(cert.authorizationBytes),
              authorization_sig: encodeBase64url(cert.authorizationSig),
              revoked_log_seq: cert.revokedLogSeq,
            })),
          });
        }
        return new Response('nope', { status: 404 });
      },
    });
    servers.push(server);
    const hubUrl = `http://127.0.0.1:${server.port}`;
    const node = await openAuth('standalone');
    await expect(
      runHubJoin(parseArgs(['hub', 'join', hubUrl, '--token', token, '--insecure-local']), hubUrl, {
        auth: node,
        skipRestart: true,
        insecureLocal: true,
        log: () => undefined,
      })
    ).rejects.toThrow(/uid mismatch/);
    expect(node.userStore.getById(user.id)).toBeNull();
    expect(node.userStore.listCertsByUser(user.id)).toEqual([]);
  });

  test('refuses re-join when admitted cert X25519 does not match local identity', async () => {
    const hub = await openAuth('hub,node');
    const added = await runHubUserAdd(parseArgs([]), 'hubuser', {
      auth: hub,
      password: 'hub-pass-word',
      log: () => undefined,
    });
    const user = hub.userStore.getById(added.userId);
    if (!user) throw new Error('missing hub user');
    const state = hub.userKeys.currentState(user.id);
    const enrollment = await createEnrollment(
      rootKeyFromSeed(await deriveSeed('hub-pass-word', state.kdfParams)),
      { uid: user.id, rootEpoch: state.rootEpoch, now: Date.now() }
    );
    const token = encodeJoinToken(enrollment.enrollSk, state.rootPublicKey, state.head.hash);
    const records = hub.keyLogStore.list(user.id);
    const certs = hub.userStore.listCertsByUser(user.id);
    const node = await openAuth('standalone');
    const identity = await ensureNodeIdentity(node.identityStore);
    const rotatedX = generateX25519KeyPair();
    const mismatchCert = createNodeCertificate(enrollment.enrollSk, {
      uid: user.id,
      edPk: identity.edPublicKey,
      x25519Pk: rotatedX.publicKey,
      enrollPk: enrollment.enrollPk,
      now: Date.now(),
      nodeId: identity.nodeId,
    });
    const mismatchRow = {
      node_id: identity.nodeIdHex,
      user_id: user.id,
      admit_record_seq: 1,
      certificate: encodeBase64url(mismatchCert.certificateBytes),
      cert_sig: encodeBase64url(mismatchCert.certSig),
      authorization: encodeBase64url(enrollment.authorizationBytes),
      authorization_sig: encodeBase64url(enrollment.authorizationSig),
      revoked_log_seq: null,
    };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/auth/mode') {
          return Response.json({
            mode: 'mesh',
            nodeId: 'self',
            uid: user.id,
            username: user.username,
          });
        }
        if (url.pathname === '/api/hub/enrollments/redeem' && req.method === 'POST') {
          return Response.json({
            user: {
              id: user.id,
              username: user.username,
              root_public_key: encodeBase64url(user.rootPublicKey),
              root_epoch: user.rootEpoch,
              kdf_params: JSON.parse(user.kdfParamsJson),
            },
            user_key_log: records.map((row) => ({
              seq: row.seq,
              bytes: encodeBase64url(row.bytes),
              sig: encodeBase64url(row.sig),
            })),
            node_certs: [
              ...certs.map((cert) => ({
                node_id: cert.nodeId,
                user_id: cert.userId,
                admit_record_seq: cert.admitRecordSeq,
                certificate: encodeBase64url(cert.certificateBytes),
                cert_sig: encodeBase64url(cert.certSig),
                authorization: encodeBase64url(cert.authorizationBytes),
                authorization_sig: encodeBase64url(cert.authorizationSig),
                revoked_log_seq: cert.revokedLogSeq,
              })),
              mismatchRow,
            ],
          });
        }
        return new Response('nope', { status: 404 });
      },
    });
    servers.push(server);
    const hubUrl = `http://127.0.0.1:${server.port}`;
    await expect(
      runHubJoin(parseArgs(['hub', 'join', hubUrl, '--token', token, '--insecure-local']), hubUrl, {
        auth: node,
        skipRestart: true,
        insecureLocal: true,
        log: () => undefined,
      })
    ).rejects.toThrow(/join identity mismatch/);
    expect(node.userStore.getById(user.id)).toBeNull();
  });

  test('runHubJoin refuses --insecure-local in production', async () => {
    const node = await openAuth('standalone');
    await expect(
      runHubJoin(
        parseArgs(['hub', 'join', 'http://127.0.0.1:9', '--token', 'x'.repeat(JOIN_TOKEN_CHARS)]),
        'http://127.0.0.1:9',
        {
          auth: node,
          skipRestart: true,
          insecureLocal: true,
          nodeEnv: 'production',
          log: () => undefined,
        }
      )
    ).rejects.toThrow(/NODE_ENV=production/);
  });
});

describe('hub join/leave service restart', () => {
  test('hub leave --no-restart skips restart and prints a manual-restart hint', async () => {
    const node = await openAuth('node');
    node.installDir = '/tmp/tmex-leave-no-restart';
    const logs: string[] = [];
    let restarted = false;
    await runHubLeave(parseArgs(['hub', 'leave', '--no-restart']), {
      auth: node,
      restart: async () => {
        restarted = true;
      },
      log: (message) => logs.push(message),
    });
    expect(restarted).toBe(false);
    expect(logs.some((line) => /restart tmex manually/i.test(line))).toBe(true);
  });

  test('hub leave does not throw when there is no service manager', async () => {
    const node = await openAuth('node');
    node.installDir = '/tmp/tmex-leave-none-manager';
    const logs: string[] = [];
    await runHubLeave(parseArgs(['hub', 'leave']), {
      auth: node,
      serviceManager: 'none',
      log: (message) => logs.push(message),
    });
    expect(logs.some((line) => /restart tmex manually/i.test(line))).toBe(true);
    expect(logs.some((line) => /left hub/i.test(line))).toBe(true);
  });

  test('hub join --no-restart skips restart after a successful join', async () => {
    const hub = await openAuth('hub,node');
    const added = await runHubUserAdd(parseArgs([]), 'hubuser', {
      auth: hub,
      password: 'hub-pass-word',
      log: () => undefined,
    });
    const user = hub.userStore.getById(added.userId);
    if (!user) throw new Error('missing hub user');
    const state = hub.userKeys.currentState(user.id);
    const enrollment = await createEnrollment(
      rootKeyFromSeed(await deriveSeed('hub-pass-word', state.kdfParams)),
      { uid: user.id, rootEpoch: state.rootEpoch, now: Date.now() }
    );
    const token = encodeJoinToken(enrollment.enrollSk, state.rootPublicKey, state.head.hash);
    const records = hub.keyLogStore.list(user.id);
    const certs = hub.userStore.listCertsByUser(user.id);
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/auth/mode') {
          return Response.json({
            mode: 'mesh',
            nodeId: 'self',
            uid: user.id,
            username: user.username,
          });
        }
        if (url.pathname === '/api/hub/enrollments/redeem' && req.method === 'POST') {
          return Response.json({
            user: {
              id: user.id,
              username: user.username,
              root_public_key: encodeBase64url(user.rootPublicKey),
              root_epoch: user.rootEpoch,
              kdf_params: JSON.parse(user.kdfParamsJson),
            },
            user_key_log: records.map((row) => ({
              seq: row.seq,
              bytes: encodeBase64url(row.bytes),
              sig: encodeBase64url(row.sig),
            })),
            node_certs: certs.map((cert) => ({
              node_id: cert.nodeId,
              user_id: cert.userId,
              admit_record_seq: cert.admitRecordSeq,
              certificate: encodeBase64url(cert.certificateBytes),
              cert_sig: encodeBase64url(cert.certSig),
              authorization: encodeBase64url(cert.authorizationBytes),
              authorization_sig: encodeBase64url(cert.authorizationSig),
              revoked_log_seq: cert.revokedLogSeq,
            })),
          });
        }
        return new Response('nope', { status: 404 });
      },
    });
    servers.push(server);
    const hubUrl = `http://127.0.0.1:${server.port}`;
    const node = await openAuth('standalone');
    node.installDir = '/tmp/tmex-join-no-restart';
    const logs: string[] = [];
    let restarted = false;
    await runHubJoin(
      parseArgs(['hub', 'join', hubUrl, '--token', token, '--insecure-local', '--no-restart']),
      hubUrl,
      {
        auth: node,
        insecureLocal: true,
        restart: async () => {
          restarted = true;
        },
        log: (message) => logs.push(message),
      }
    );
    expect(restarted).toBe(false);
    expect(logs.some((line) => /restart tmex manually/i.test(line))).toBe(true);
    expect(logs.some((line) => line.startsWith('joined hub'))).toBe(true);
  });

  test('hub join writes TMEX_ROLES/TMEX_HUB_URL and calls restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-join-env-'));
    try {
      const envPath = join(dir, 'app.env');
      await writeFile(
        envPath,
        'TMEX_ROLES=standalone\nOTHER=keep\nTMEX_HUB_PUBLIC_URL=https://stale.example\n',
        'utf8'
      );
      const hub = await startJoinableHub('alice', 'hub-pass-word');
      const node = await openAuth('standalone');
      node.envPath = envPath;
      node.env = { TMEX_ROLES: 'standalone', OTHER: 'keep' };
      node.installDir = dir;
      let restarted = 0;
      const joined = await runHubJoin(
        parseArgs(['hub', 'join', hub.url, '--token', hub.token, '--insecure-local']),
        hub.url,
        {
          auth: node,
          insecureLocal: true,
          restart: async () => {
            restarted += 1;
          },
          log: () => undefined,
        }
      );
      expect(joined.hubUrl).toBe(hub.url);
      expect(restarted).toBe(1);
      const env = await readEnvFile(envPath);
      expect(env.TMEX_ROLES).toBe('node');
      expect(env.TMEX_HUB_URL).toBe(hub.url);
      expect(env.TMEX_HUB_PUBLIC_URL).toBe('');
      expect(env.OTHER).toBe('keep');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function startJoinableHub(
  username: string,
  password: string
): Promise<{
  user: NonNullable<ReturnType<LocalAuthContext['userStore']['getById']>>;
  token: string;
  url: string;
}> {
  const hub = await openAuth('hub,node');
  const added = await runHubUserAdd(parseArgs([]), username, {
    auth: hub,
    password,
    log: () => undefined,
  });
  const user = hub.userStore.getById(added.userId);
  if (!user) throw new Error('missing hub user');
  const state = hub.userKeys.currentState(user.id);
  const enrollment = await createEnrollment(
    rootKeyFromSeed(await deriveSeed(password, state.kdfParams)),
    { uid: user.id, rootEpoch: state.rootEpoch, now: Date.now() }
  );
  const token = encodeJoinToken(enrollment.enrollSk, state.rootPublicKey, state.head.hash);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const live = hub.userStore.getById(user.id) ?? user;
      const records = hub.keyLogStore.list(user.id);
      const certs = hub.userStore.listCertsByUser(user.id);
      if (url.pathname === '/api/auth/mode') {
        return Response.json({
          mode: 'mesh',
          nodeId: 'self',
          uid: user.id,
          username: live.username,
        });
      }
      if (url.pathname === '/api/hub/enrollments/redeem' && req.method === 'POST') {
        return Response.json({
          user: {
            id: user.id,
            username: live.username,
            root_public_key: encodeBase64url(live.rootPublicKey),
            root_epoch: live.rootEpoch,
            kdf_params: JSON.parse(live.kdfParamsJson),
          },
          user_key_log: records.map((row) => ({
            seq: row.seq,
            bytes: encodeBase64url(row.bytes),
            sig: encodeBase64url(row.sig),
          })),
          node_certs: certs.map((cert) => ({
            node_id: cert.nodeId,
            user_id: cert.userId,
            admit_record_seq: cert.admitRecordSeq,
            certificate: encodeBase64url(cert.certificateBytes),
            cert_sig: encodeBase64url(cert.certSig),
            authorization: encodeBase64url(cert.authorizationBytes),
            authorization_sig: encodeBase64url(cert.authorizationSig),
            revoked_log_seq: cert.revokedLogSeq,
          })),
        });
      }
      return new Response('nope', { status: 404 });
    },
  });
  servers.push(server);
  return { user, token, url: `http://127.0.0.1:${server.port}` };
}

describe('hub join rebuilt hub and re-join', () => {
  test('hub leave clears local membership so a rebuilt hub join starts fresh', async () => {
    const h1 = await startJoinableHub('alice', 'hub-pass-one');
    const node = await openAuth('standalone');
    await runHubJoin(
      parseArgs(['hub', 'join', h1.url, '--token', h1.token, '--insecure-local']),
      h1.url,
      { auth: node, skipRestart: true, insecureLocal: true, log: () => undefined }
    );
    expect(node.userStore.getByUsername('alice')?.id).toBe(h1.user.id);

    await runHubLeave(parseArgs(['hub', 'leave']), {
      auth: node,
      skipRestart: true,
      log: () => undefined,
    });
    expect(node.userStore.getByUsername('alice')).toBeNull();
    expect(node.userStore.listUsers()).toHaveLength(0);
    expect(await node.identityStore.load()).toBeNull();

    const h2 = await startJoinableHub('alice', 'hub-pass-two');
    expect(h2.user.id).not.toBe(h1.user.id);
    const joined = await runHubJoin(
      parseArgs(['hub', 'join', h2.url, '--token', h2.token, '--insecure-local']),
      h2.url,
      { auth: node, skipRestart: true, insecureLocal: true, log: () => undefined }
    );
    expect(joined.userId).toBe(h2.user.id);
    expect(node.userStore.getByUsername('alice')?.id).toBe(h2.user.id);
    expect(node.userStore.getById(h1.user.id)).toBeNull();
    expect(node.userStore.listUsers()).toHaveLength(1);
    expect(node.keyLogStore.list(h1.user.id)).toHaveLength(0);
    expect(node.keyLogStore.list(h2.user.id).length).toBeGreaterThan(0);
    expect((await node.identityStore.load())?.userId).toBe(h2.user.id);
  });

  test('joins a rebuilt hub from role node without hub leave', async () => {
    const h1 = await startJoinableHub('alice', 'hub-pass-one');
    const node = await openAuth('node');
    await runHubJoin(
      parseArgs(['hub', 'join', h1.url, '--token', h1.token, '--insecure-local']),
      h1.url,
      { auth: node, skipRestart: true, insecureLocal: true, log: () => undefined }
    );
    const h2 = await startJoinableHub('alice', 'hub-pass-two');
    const logs: string[] = [];
    const joined = await runHubJoin(
      parseArgs(['hub', 'join', h2.url, '--token', h2.token, '--insecure-local']),
      h2.url,
      { auth: node, skipRestart: true, insecureLocal: true, log: (message) => logs.push(message) }
    );
    expect(joined.userId).toBe(h2.user.id);
    expect(node.userStore.getByUsername('alice')?.id).toBe(h2.user.id);
    expect(node.userStore.getById(h1.user.id)).toBeNull();
    expect(logs.some((line) => /replaced local account/i.test(line))).toBe(true);
  });

  test('same-uid re-join is idempotent', async () => {
    const hub = await startJoinableHub('alice', 'hub-pass-word');
    const node = await openAuth('standalone');
    const first = await runHubJoin(
      parseArgs(['hub', 'join', hub.url, '--token', hub.token, '--insecure-local']),
      hub.url,
      { auth: node, skipRestart: true, insecureLocal: true, log: () => undefined }
    );
    const logCount = node.keyLogStore.list(hub.user.id).length;
    const certCount = node.userStore.listCertsByUser(hub.user.id).length;
    const second = await runHubJoin(
      parseArgs(['hub', 'join', hub.url, '--token', hub.token, '--insecure-local']),
      hub.url,
      { auth: node, skipRestart: true, insecureLocal: true, log: () => undefined }
    );
    expect(second.userId).toBe(first.userId);
    expect(node.userStore.listUsers()).toHaveLength(1);
    expect(node.keyLogStore.list(hub.user.id)).toHaveLength(logCount);
    expect(node.userStore.listCertsByUser(hub.user.id)).toHaveLength(certCount);
  });

  test('refuses join when redeem reports node_revoked', async () => {
    const hub = await openAuth('hub,node');
    const added = await runHubUserAdd(parseArgs([]), 'alice', {
      auth: hub,
      password: 'hub-pass-word',
      log: () => undefined,
    });
    const user = hub.userStore.getById(added.userId);
    if (!user) throw new Error('missing hub user');
    const state = hub.userKeys.currentState(user.id);
    const enrollment = await createEnrollment(
      rootKeyFromSeed(await deriveSeed('hub-pass-word', state.kdfParams)),
      { uid: user.id, rootEpoch: state.rootEpoch, now: Date.now() }
    );
    const token = encodeJoinToken(enrollment.enrollSk, state.rootPublicKey, state.head.hash);
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/auth/mode') {
          return Response.json({
            mode: 'mesh',
            nodeId: 'self',
            uid: user.id,
            username: user.username,
          });
        }
        if (url.pathname === '/api/hub/enrollments/redeem' && req.method === 'POST') {
          return Response.json({ error: 'node_revoked' }, { status: 409 });
        }
        return new Response('nope', { status: 404 });
      },
    });
    servers.push(server);
    const node = await openAuth('standalone');
    await expect(
      runHubJoin(
        parseArgs([
          'hub',
          'join',
          `http://127.0.0.1:${server.port}`,
          '--token',
          token,
          '--insecure-local',
        ]),
        `http://127.0.0.1:${server.port}`,
        { auth: node, skipRestart: true, insecureLocal: true, log: () => undefined }
      )
    ).rejects.toThrow(NODE_REVOKED_REJOIN_ERROR);
  });

  test('refuses join when the hub returns a revoked cert for this node', async () => {
    const hub = await openAuth('hub,node');
    const added = await runHubUserAdd(parseArgs([]), 'alice', {
      auth: hub,
      password: 'hub-pass-word',
      log: () => undefined,
    });
    const user = hub.userStore.getById(added.userId);
    if (!user) throw new Error('missing hub user');
    const state = hub.userKeys.currentState(user.id);
    const enrollment = await createEnrollment(
      rootKeyFromSeed(await deriveSeed('hub-pass-word', state.kdfParams)),
      { uid: user.id, rootEpoch: state.rootEpoch, now: Date.now() }
    );
    const token = encodeJoinToken(enrollment.enrollSk, state.rootPublicKey, state.head.hash);
    const records = hub.keyLogStore.list(user.id);
    const certs = hub.userStore.listCertsByUser(user.id);
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/auth/mode') {
          return Response.json({
            mode: 'mesh',
            nodeId: 'self',
            uid: user.id,
            username: user.username,
          });
        }
        if (url.pathname === '/api/hub/enrollments/redeem' && req.method === 'POST') {
          const body = (await req.json()) as { certificate: string; cert_sig: string };
          const decoded = decodeCertificate(decodeBase64url(body.certificate));
          return Response.json({
            user: {
              id: user.id,
              username: user.username,
              root_public_key: encodeBase64url(user.rootPublicKey),
              root_epoch: user.rootEpoch,
              kdf_params: JSON.parse(user.kdfParamsJson),
            },
            user_key_log: records.map((row) => ({
              seq: row.seq,
              bytes: encodeBase64url(row.bytes),
              sig: encodeBase64url(row.sig),
            })),
            node_certs: [
              ...certs.map((cert) => ({
                node_id: cert.nodeId,
                user_id: cert.userId,
                admit_record_seq: cert.admitRecordSeq,
                certificate: encodeBase64url(cert.certificateBytes),
                cert_sig: encodeBase64url(cert.certSig),
                authorization: encodeBase64url(cert.authorizationBytes),
                authorization_sig: encodeBase64url(cert.authorizationSig),
                revoked_log_seq: cert.revokedLogSeq,
              })),
              {
                node_id: nodeIdToHex(decoded.node_id),
                user_id: user.id,
                admit_record_seq: 2,
                certificate: body.certificate,
                cert_sig: body.cert_sig,
                authorization: encodeBase64url(certs[0]?.authorizationBytes ?? randomBytes(32)),
                authorization_sig: encodeBase64url(certs[0]?.authorizationSig ?? randomBytes(64)),
                revoked_log_seq: 9,
              },
            ],
          });
        }
        return new Response('nope', { status: 404 });
      },
    });
    servers.push(server);
    const node = await openAuth('standalone');
    await expect(
      runHubJoin(
        parseArgs([
          'hub',
          'join',
          `http://127.0.0.1:${server.port}`,
          '--token',
          token,
          '--insecure-local',
        ]),
        `http://127.0.0.1:${server.port}`,
        { auth: node, skipRestart: true, insecureLocal: true, log: () => undefined }
      )
    ).rejects.toThrow(NODE_REVOKED_REJOIN_ERROR);
  });
});

describe('performHubJoin CA pin', () => {
  test('v1 token does not fetch ca.crt', async () => {
    const hub = await openAuth('hub,node');
    const added = await runHubUserAdd(parseArgs([]), 'hubuser', {
      auth: hub,
      password: 'hub-pass-word',
      log: () => undefined,
    });
    const user = hub.userStore.getById(added.userId);
    if (!user) throw new Error('missing hub user');
    const state = hub.userKeys.currentState(user.id);
    const enrollment = await createEnrollment(
      rootKeyFromSeed(await deriveSeed('hub-pass-word', state.kdfParams)),
      { uid: user.id, rootEpoch: state.rootEpoch, now: Date.now() }
    );
    const token = encodeJoinToken(enrollment.enrollSk, state.rootPublicKey, state.head.hash);
    const records = hub.keyLogStore.list(user.id);
    const certs = hub.userStore.listCertsByUser(user.id);
    const paths: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === '/api/auth/mode') {
        return Response.json({
          mode: 'mesh',
          nodeId: 'self',
          uid: user.id,
          username: user.username,
        });
      }
      if (url.pathname === '/api/hub/enrollments/redeem') {
        return Response.json({
          user: {
            id: user.id,
            username: user.username,
            root_public_key: encodeBase64url(user.rootPublicKey),
            root_epoch: user.rootEpoch,
            kdf_params: JSON.parse(user.kdfParamsJson),
          },
          user_key_log: records.map((row) => ({
            seq: row.seq,
            bytes: encodeBase64url(row.bytes),
            sig: encodeBase64url(row.sig),
          })),
          node_certs: certs.map((cert) => ({
            node_id: cert.nodeId,
            user_id: cert.userId,
            admit_record_seq: cert.admitRecordSeq,
            certificate: encodeBase64url(cert.certificateBytes),
            cert_sig: encodeBase64url(cert.certSig),
            authorization: encodeBase64url(cert.authorizationBytes),
            authorization_sig: encodeBase64url(cert.authorizationSig),
            revoked_log_seq: cert.revokedLogSeq,
          })),
        });
      }
      return new Response('nope', { status: 404 });
    };
    const node = await openAuth('standalone');
    await performHubJoin(
      {
        hubUrl: 'http://127.0.0.1:9',
        token,
        name: 'studio',
        insecureLocal: true,
        nodeEnv: 'test',
      },
      { auth: node, fetcher }
    );
    expect(paths).not.toContain('/api/tls/ca.crt');
    expect(new HubTrustStore(node.db).get('http://127.0.0.1:9')).toBeNull();
  });

  test('v2 token mismatch rejects before redeem', async () => {
    const ca = await createCa({ name: 'tmex-test' });
    const token = encodeJoinToken(
      randomBytes(32),
      randomBytes(32),
      randomBytes(32),
      'ff'.repeat(32)
    );
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/tls/ca.crt') {
        expect((init as { tls?: { rejectUnauthorized?: boolean } } | undefined)?.tls).toEqual({
          rejectUnauthorized: false,
        });
        return new Response(ca.certPem, {
          status: 200,
          headers: { 'content-type': 'application/x-x509-ca-cert' },
        });
      }
      throw new Error(`unexpected ${url.pathname}`);
    };
    const node = await openAuth('standalone');
    await expect(
      performHubJoin(
        {
          hubUrl: 'http://127.0.0.1:9',
          token,
          name: 'studio',
          insecureLocal: true,
          nodeEnv: 'test',
        },
        { auth: node, fetcher }
      )
    ).rejects.toMatchObject({ code: 'join_failed', message: 'ca_fingerprint_mismatch' });
    expect(new HubTrustStore(node.db).get('http://127.0.0.1:9')).toBeNull();
  });

  test('v2 token match pins CA and persists hub_trust', async () => {
    const ca = await createCa({ name: 'tmex-test' });
    const fingerprint = await spkiFingerprint(ca.certPem);
    const hub = await openAuth('hub,node');
    const added = await runHubUserAdd(parseArgs([]), 'hubuser', {
      auth: hub,
      password: 'hub-pass-word',
      log: () => undefined,
    });
    const user = hub.userStore.getById(added.userId);
    if (!user) throw new Error('missing hub user');
    const state = hub.userKeys.currentState(user.id);
    const enrollment = await createEnrollment(
      rootKeyFromSeed(await deriveSeed('hub-pass-word', state.kdfParams)),
      { uid: user.id, rootEpoch: state.rootEpoch, now: Date.now() }
    );
    const token = encodeJoinToken(
      enrollment.enrollSk,
      state.rootPublicKey,
      state.head.hash,
      fingerprint
    );
    const records = hub.keyLogStore.list(user.id);
    const certs = hub.userStore.listCertsByUser(user.id);
    const tlsOpts: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      tlsOpts.push((init as { tls?: unknown } | undefined)?.tls);
      if (url.pathname === '/api/tls/ca.crt') {
        return new Response(ca.certPem, { status: 200 });
      }
      if (url.pathname === '/api/auth/mode') {
        return Response.json({
          mode: 'mesh',
          nodeId: 'self',
          uid: user.id,
          username: user.username,
        });
      }
      if (url.pathname === '/api/hub/enrollments/redeem') {
        return Response.json({
          user: {
            id: user.id,
            username: user.username,
            root_public_key: encodeBase64url(user.rootPublicKey),
            root_epoch: user.rootEpoch,
            kdf_params: JSON.parse(user.kdfParamsJson),
          },
          user_key_log: records.map((row) => ({
            seq: row.seq,
            bytes: encodeBase64url(row.bytes),
            sig: encodeBase64url(row.sig),
          })),
          node_certs: certs.map((cert) => ({
            node_id: cert.nodeId,
            user_id: cert.userId,
            admit_record_seq: cert.admitRecordSeq,
            certificate: encodeBase64url(cert.certificateBytes),
            cert_sig: encodeBase64url(cert.certSig),
            authorization: encodeBase64url(cert.authorizationBytes),
            authorization_sig: encodeBase64url(cert.authorizationSig),
            revoked_log_seq: cert.revokedLogSeq,
          })),
        });
      }
      return new Response('nope', { status: 404 });
    };
    const node = await openAuth('standalone');
    await performHubJoin(
      {
        hubUrl: 'http://127.0.0.1:9',
        token,
        name: 'studio',
        insecureLocal: true,
        nodeEnv: 'test',
      },
      { auth: node, fetcher }
    );
    expect(tlsOpts[0]).toEqual({ rejectUnauthorized: false });
    expect(tlsOpts.slice(1).every((tls) => (tls as { ca?: string[] }).ca?.[0] === ca.certPem)).toBe(
      true
    );
    const trusted = new HubTrustStore(node.db).get('http://127.0.0.1:9');
    expect(trusted?.fingerprint).toBe(fingerprint);
    expect(trusted?.caPem).toContain('BEGIN CERTIFICATE');
    expect(await spkiFingerprint(trusted?.caPem ?? '')).toBe(fingerprint);
  });

  test('rejects real CA concatenated with an attacker CA', async () => {
    const ca = await createCa({ name: 'real' });
    const attacker = await createCa({ name: 'attacker' });
    const fingerprint = await spkiFingerprint(ca.certPem);
    const token = encodeJoinToken(randomBytes(32), randomBytes(32), randomBytes(32), fingerprint);
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/tls/ca.crt') {
        return new Response(`${ca.certPem}\n${attacker.certPem}`, { status: 200 });
      }
      throw new Error(`unexpected ${url.pathname}`);
    };
    const node = await openAuth('standalone');
    await expect(
      performHubJoin(
        {
          hubUrl: 'http://127.0.0.1:9',
          token,
          name: 'studio',
          insecureLocal: true,
          nodeEnv: 'test',
        },
        { auth: node, fetcher }
      )
    ).rejects.toMatchObject({ code: 'join_failed', message: 'ca_invalid' });
    expect(new HubTrustStore(node.db).get('http://127.0.0.1:9')).toBeNull();
  });

  test('rejects trailing garbage after the CA PEM', async () => {
    const ca = await createCa({ name: 'tmex-test' });
    const fingerprint = await spkiFingerprint(ca.certPem);
    const token = encodeJoinToken(randomBytes(32), randomBytes(32), randomBytes(32), fingerprint);
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/tls/ca.crt') {
        return new Response(`${ca.certPem}\n# junk\n`, { status: 200 });
      }
      throw new Error(`unexpected ${url.pathname}`);
    };
    const node = await openAuth('standalone');
    await expect(
      performHubJoin(
        {
          hubUrl: 'http://127.0.0.1:9',
          token,
          name: 'studio',
          insecureLocal: true,
          nodeEnv: 'test',
        },
        { auth: node, fetcher }
      )
    ).rejects.toMatchObject({ code: 'join_failed', message: 'ca_invalid' });
  });

  test('rejects an oversized CA response', async () => {
    const ca = await createCa({ name: 'tmex-test' });
    const fingerprint = await spkiFingerprint(ca.certPem);
    const token = encodeJoinToken(randomBytes(32), randomBytes(32), randomBytes(32), fingerprint);
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/tls/ca.crt') {
        return new Response('x'.repeat(MAX_CA_RESPONSE_BYTES + 1), { status: 200 });
      }
      throw new Error(`unexpected ${url.pathname}`);
    };
    const node = await openAuth('standalone');
    await expect(
      performHubJoin(
        {
          hubUrl: 'http://127.0.0.1:9',
          token,
          name: 'studio',
          insecureLocal: true,
          nodeEnv: 'test',
        },
        { auth: node, fetcher }
      )
    ).rejects.toMatchObject({ code: 'join_failed', message: 'ca_response_too_large' });
  });

  test('rejects a non-CA leaf certificate', async () => {
    const ca = await createCa({ name: 'tmex-test' });
    const leaf = await issueLeaf({ ca, sans: ['127.0.0.1'], days: 1 });
    const fingerprint = await spkiFingerprint(leaf.certPem);
    const token = encodeJoinToken(randomBytes(32), randomBytes(32), randomBytes(32), fingerprint);
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/tls/ca.crt') {
        return new Response(leaf.certPem, { status: 200 });
      }
      throw new Error(`unexpected ${url.pathname}`);
    };
    const node = await openAuth('standalone');
    await expect(
      performHubJoin(
        {
          hubUrl: 'http://127.0.0.1:9',
          token,
          name: 'studio',
          insecureLocal: true,
          nodeEnv: 'test',
        },
        { auth: node, fetcher }
      )
    ).rejects.toMatchObject({ code: 'join_failed', message: 'ca_invalid' });
  });
});

describe('performHubJoin auth mode errors', () => {
  test('preserves network failure cause', async () => {
    const token = encodeJoinToken(randomBytes(32), randomBytes(32), randomBytes(32));
    const fetcher: typeof fetch = async () => {
      throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    const node = await openAuth('standalone');
    await expect(
      performHubJoin(
        {
          hubUrl: 'http://127.0.0.1:9',
          token,
          name: 'studio',
          insecureLocal: true,
          nodeEnv: 'test',
        },
        { auth: node, fetcher }
      )
    ).rejects.toMatchObject({
      code: 'hub_unreachable',
      message: expect.stringMatching(/network error.*ECONNREFUSED/i),
    });
  });

  test('pinned TLS failure advises checking the CA and hostname', async () => {
    const ca = await createCa({ name: 'tmex-test' });
    const fingerprint = await spkiFingerprint(ca.certPem);
    const token = encodeJoinToken(randomBytes(32), randomBytes(32), randomBytes(32), fingerprint);
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/tls/ca.crt') {
        return new Response(ca.certPem, { status: 200 });
      }
      throw Object.assign(new Error('unable to verify the first certificate'), {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      });
    };
    const node = await openAuth('standalone');
    await expect(
      performHubJoin(
        {
          hubUrl: 'http://127.0.0.1:9',
          token,
          name: 'studio',
          insecureLocal: true,
          nodeEnv: 'test',
        },
        { auth: node, fetcher }
      )
    ).rejects.toMatchObject({
      code: 'hub_unreachable',
      message: expect.stringMatching(/TLS verification failed.*pinned CA and hub hostname/i),
    });
  });

  test('v1 TLS failure against a self-signed hub advises generating a v2 token', async () => {
    const token = encodeJoinToken(randomBytes(32), randomBytes(32), randomBytes(32));
    const fetcher: typeof fetch = async () => {
      throw Object.assign(new Error('self signed certificate'), {
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      });
    };
    const node = await openAuth('standalone');
    await expect(
      performHubJoin(
        {
          hubUrl: 'http://127.0.0.1:9',
          token,
          name: 'studio',
          insecureLocal: true,
          nodeEnv: 'test',
        },
        { auth: node, fetcher }
      )
    ).rejects.toMatchObject({
      code: 'hub_unreachable',
      message: expect.stringMatching(/self-signed certificate.*v2 join token/i),
    });
  });
});
