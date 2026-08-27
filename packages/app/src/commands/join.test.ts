import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  JOIN_TOKEN_CHARS,
  createEnrollment,
  deriveSeed,
  encodeBase64url,
  encodeJoinToken,
  randomBytes,
  rootKeyFromSeed,
} from '../../../shared/src/auth';
import { parseArgs } from '../lib/args';
import { assertHubJoinUrl } from '../lib/hub-client';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { runHubJoin, runHubLeave, runHubUserAdd } from './hub';

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

    await runHubLeave(parseArgs(['hub', 'leave']), {
      auth: node,
      skipRestart: true,
      log: () => undefined,
    });
    expect((await node.identityStore.load())?.hubUrl).toBeNull();

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
