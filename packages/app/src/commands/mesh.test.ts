import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  meshRelays,
  meshSecrets,
  nodeIdentity,
  nodeSessions,
} from '../../../../apps/gateway/src/db/schema';
import { encodeBase64url } from '../../../shared/src/auth';
import { parseArgs } from '../lib/args';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { runHubUserAdd } from './hub';
import {
  type MeshKeyLogStatus,
  keyLogStatusVerdict,
  runMeshKeylogStatus,
  runMeshPasskeyRemoveAll,
  runMeshResetIdentity,
  runMeshResetRoot,
} from './mesh';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const parsed = parseArgs([]);
const handles: LocalAuthContext[] = [];

afterEach(() => {
  for (const ctx of handles.splice(0)) ctx.close();
});

describe('mesh reset-root', () => {
  test('refuses standalone roles', async () => {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        VIBETERM_MASTER_KEY: process.env.VIBETERM_MASTER_KEY || '',
        VIBETERM_ROLES: 'standalone',
      },
    });
    handles.push(auth);
    await expect(
      runMeshResetRoot(parsed, { auth, password: 'x', log: () => undefined })
    ).rejects.toThrow(/standalone/);
  });

  test('bumps epoch, clears old certs, and re-admits this machine', async () => {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        VIBETERM_MASTER_KEY: process.env.VIBETERM_MASTER_KEY || '',
        VIBETERM_ROLES: 'hub,node',
      },
    });
    handles.push(auth);
    const added = await runHubUserAdd(parsed, 'erin', {
      auth,
      password: 'first-pass-word',
      log: () => undefined,
    });
    expect(added.rootEpoch).toBe(1);
    const beforeCerts = auth.userStore.listCertsByUser(added.userId);
    expect(beforeCerts.length).toBe(1);

    const reset = await runMeshResetRoot(parseArgs(['--yes']), {
      auth,
      password: 'second-pass-word',
      log: () => undefined,
    });
    expect(reset.rootEpoch).toBeGreaterThan(added.rootEpoch);
    const after = auth.userStore.getById(added.userId);
    if (!after) throw new Error('missing user after reset');
    expect(after.username).toBe('erin');
    const certs = auth.userStore.listCertsByUser(added.userId);
    expect(certs.length).toBe(1);
    expect(auth.keyLogStore.list(added.userId).map((row) => row.seq)).toEqual([1, 2]);
    expect(beforeCerts[0]?.certificateBytes).not.toEqual(certs[0]?.certificateBytes);
    expect((await auth.identityStore.load())?.userId).toBe(added.userId);
  });
});

describe('mesh passkey remove-all', () => {
  async function openAuth(): Promise<LocalAuthContext> {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: {
        VIBETERM_MASTER_KEY: process.env.VIBETERM_MASTER_KEY || '',
        VIBETERM_ROLES: 'hub,node',
      },
    });
    handles.push(auth);
    return auth;
  }

  function addPasskey(auth: LocalAuthContext, userId: string, fill: number): void {
    auth.userStore.insertKey({
      id: crypto.randomUUID(),
      userId,
      credentialId: new Uint8Array(16).fill(fill),
      publicKey: new Uint8Array(32).fill(fill),
      rpId: 'relay.example',
      origin: 'https://relay.example',
      counter: 0,
      name: `key-${fill}`,
      logSeq: 1,
      now: Date.now(),
    });
  }

  test('removes every passkey and keeps the root key', async () => {
    const auth = await openAuth();
    const added = await runHubUserAdd(parsed, 'frank', {
      auth,
      password: 'first-pass-word',
      log: () => undefined,
    });
    addPasskey(auth, added.userId, 1);
    addPasskey(auth, added.userId, 2);
    const before = auth.userStore.getById(added.userId);

    const result = await runMeshPasskeyRemoveAll(parsed, 'frank', {
      auth,
      password: 'first-pass-word',
      log: () => undefined,
    });

    expect(result).toEqual({ userId: added.userId, removed: 2 });
    expect(auth.userStore.listKeysByUser(added.userId)).toHaveLength(0);
    const after = auth.userStore.getById(added.userId);
    // 只签 remove-passkey：根钥世代与公钥都不动，会话与两步验证也就不受影响。
    expect(after?.rootEpoch).toBe(before?.rootEpoch as number);
    expect(after?.rootPublicKey).toEqual(before?.rootPublicKey as Uint8Array);
    expect(auth.keyLogStore.list(added.userId).map((row) => row.seq)).toEqual([1, 2, 3, 4]);
  });

  // remove-passkey 的副作用是按凭证注销会话：密码会话不受影响，通行密钥会话必须掉线。
  test('password sessions survive, passkey sessions are revoked', async () => {
    const auth = await openAuth();
    const added = await runHubUserAdd(parsed, 'judy', {
      auth,
      password: 'first-pass-word',
      log: () => undefined,
    });
    const credentialId = new Uint8Array(16).fill(7);
    auth.userStore.insertKey({
      id: crypto.randomUUID(),
      userId: added.userId,
      credentialId,
      publicKey: new Uint8Array(32).fill(7),
      rpId: 'relay.example',
      origin: 'https://relay.example',
      counter: 0,
      name: 'key-7',
      logSeq: 1,
      now: Date.now(),
    });
    const now = Date.now();
    const viaNodeId = 'self';
    const password = auth.nodeSessionStore.issue({
      userId: added.userId,
      viaNodeId,
      sessPublicKey: new Uint8Array(32).fill(1),
      delegationMethod: 'root',
      now,
    });
    const passkey = auth.nodeSessionStore.issue({
      userId: added.userId,
      viaNodeId,
      sessPublicKey: new Uint8Array(32).fill(2),
      delegationMethod: 'passkey',
      credentialId,
      now,
    });

    await runMeshPasskeyRemoveAll(parsed, 'judy', {
      auth,
      password: 'first-pass-word',
      log: () => undefined,
    });

    expect(auth.nodeSessionStore.verify(password.sid, { viaNodeId, now: now + 1 }).ok).toBe(true);
    expect(auth.nodeSessionStore.verify(passkey.sid, { viaNodeId, now: now + 1 }).ok).toBe(false);
  });

  test('a wrong password changes nothing', async () => {
    const auth = await openAuth();
    const added = await runHubUserAdd(parsed, 'grace', {
      auth,
      password: 'first-pass-word',
      log: () => undefined,
    });
    addPasskey(auth, added.userId, 3);

    await expect(
      runMeshPasskeyRemoveAll(parsed, 'grace', {
        auth,
        password: 'wrong-pass-word',
        log: () => undefined,
      })
    ).rejects.toThrow(/root public key/);
    expect(auth.userStore.listKeysByUser(added.userId)).toHaveLength(1);
  });

  test('an unknown username is refused', async () => {
    const auth = await openAuth();
    await runHubUserAdd(parsed, 'heidi', {
      auth,
      password: 'first-pass-word',
      log: () => undefined,
    });
    await expect(
      runMeshPasskeyRemoveAll(parsed, 'nobody', {
        auth,
        password: 'first-pass-word',
        log: () => undefined,
      })
    ).rejects.toThrow(/unknown user/);
  });

  test('no username falls back to the only local user and is a no-op without passkeys', async () => {
    const auth = await openAuth();
    const added = await runHubUserAdd(parsed, 'ivan', {
      auth,
      password: 'first-pass-word',
      log: () => undefined,
    });
    const result = await runMeshPasskeyRemoveAll(parsed, '', {
      auth,
      password: 'first-pass-word',
      log: () => undefined,
    });
    expect(result).toEqual({ userId: added.userId, removed: 0 });
    expect(auth.keyLogStore.list(added.userId).map((row) => row.seq)).toEqual([1, 2]);
  });
});

describe('mesh recovery commands', () => {
  async function openAuth() {
    const auth = await openLocalAuth({
      memory: true,
      migrationsFolder: MIGRATIONS,
      env: { VIBETERM_MASTER_KEY: process.env.VIBETERM_MASTER_KEY || '', VIBETERM_ROLES: 'node' },
    });
    handles.push(auth);
    const user = await runHubUserAdd(parsed, 'recovery', {
      auth,
      password: 'first-pass-word',
      log() {},
    });
    return { auth, user };
  }

  test('reset-root refuses before mutation without non-TTY --yes', async () => {
    const { auth, user } = await openAuth();
    const before = auth.keyLogStore.head(user.userId);
    await expect(
      runMeshResetRoot(parsed, { auth, password: 'new-password', isTTY: false, log() {} })
    ).rejects.toThrow();
    expect(auth.keyLogStore.head(user.userId)).toEqual(before);
  });

  test('reset-identity replaces unreadable keys and clears uplink secrets, preserving account credentials', async () => {
    const { auth, user } = await openAuth();
    const before = auth.userStore.getById(user.userId);
    const oldIdentity = auth.db.select().from(nodeIdentity).get();
    auth.db
      .update(nodeIdentity)
      .set({ privateKey: 'unreadable', x25519PrivateKey: 'unreadable' })
      .run();
    auth.db
      .insert(meshRelays)
      .values({
        url: 'https://relay.invalid',
        tenantId: 'tenant',
        tokenEnc: 'unreadable',
        priority: 0,
        updatedAt: 1,
      })
      .run();
    auth.db
      .insert(meshSecrets)
      .values({ kind: 'log', epoch: 0, keyEnc: 'unreadable', createdAt: 1 })
      .run();
    auth.nodeSessionStore.issue({
      userId: user.userId,
      viaNodeId: 'self',
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now: 1,
    });
    await expect(auth.identityStore.load()).rejects.toThrow();
    const reset = await runMeshResetIdentity(parseArgs(['--yes']), { auth, log() {} });
    expect(reset.nodeId).not.toBe(oldIdentity?.nodeId);
    const identity = await auth.identityStore.load();
    expect(identity?.nodeId).toBe(reset.nodeId);
    expect(identity?.userId).toBeNull();
    expect(identity?.certSig).toHaveLength(0);
    expect(auth.userStore.getById(user.userId)).toEqual(before);
    expect(auth.db.select().from(meshSecrets).all()).toHaveLength(0);
    expect(auth.db.select().from(meshRelays).all()).toHaveLength(0);
    expect(auth.db.select().from(nodeSessions).all()).toHaveLength(0);
  });

  test('rebuilt identity can be admitted and committed through the join path', async () => {
    const { auth } = await openAuth();
    const { auth: healthy, user } = await openAuth();
    const { ensureNodeIdentity, selfSignedNodeCertificate } = await import(
      '../../../../apps/gateway/src/auth/node-identity-service'
    );
    const { deriveRootKey } = await import('../lib/password');
    const { kdfParamsFromJson } = await import(
      '../../../../apps/gateway/src/auth/user-key-service'
    );
    const { encodeAdmitNodePayload } = await import('../../../shared/src/auth');
    auth.db.update(nodeIdentity).set({ privateKey: 'unreadable' }).run();
    const reset = await runMeshResetIdentity(parseArgs(['--yes']), { auth, log() {} });
    const identity = await ensureNodeIdentity(auth.identityStore);
    expect(identity.nodeIdHex).toBe(reset.nodeId);
    const hubUser = healthy.userStore.getById(user.userId)!;
    const root = await deriveRootKey('first-pass-word', kdfParamsFromJson(hubUser.kdfParamsJson));
    const admit = await selfSignedNodeCertificate(identity, root, {
      uid: user.userId,
      rootEpoch: hubUser.rootEpoch,
      now: Date.now(),
    });
    const admitted = await healthy.userKeys.signAndApply(user.userId, root, {
      type: 'admit-node',
      payload: encodeAdmitNodePayload(admit),
    });
    expect(admitted.ok).toBe(true);
    const head = healthy.keyLogStore.head(user.userId)!;
    const committed = await auth.userKeys.commitJoin({
      records: healthy.keyLogStore.list(user.userId),
      expectedRootPublicKey: hubUser.rootPublicKey,
      anchorHash: head.hash,
      username: hubUser.username,
      expectedUserId: user.userId,
      identity: {
        nodeId: identity.nodeIdHex,
        hubUrl: 'https://hub.invalid',
        edPrivateKey: identity.edPrivateKey,
        x25519PrivateKey: identity.x25519PrivateKey,
        certificateJson: JSON.stringify({
          x25519PublicKey: encodeBase64url(identity.x25519PublicKey),
          certificate: encodeBase64url(admit.certificate_bytes),
        }),
        certSig: admit.cert_sig,
        userId: user.userId,
      },
    });
    root.seed.fill(0);
    expect(committed.ok).toBe(true);
    expect((await auth.identityStore.load())?.userId).toBe(user.userId);
    expect(
      auth.userStore.listCertsByUser(user.userId).some((cert) => cert.nodeId === reset.nodeId)
    ).toBe(true);
    expect(auth.keyLogStore.head(user.userId)).toEqual(head);
  });

  test('reset-identity refuses before touching unreadable keys without confirmation', async () => {
    const { auth } = await openAuth();
    auth.db.update(nodeIdentity).set({ privateKey: 'unreadable' }).run();
    await expect(runMeshResetIdentity(parsed, { auth, isTTY: false, log() {} })).rejects.toThrow();
    expect(auth.db.select().from(nodeIdentity).get()?.privateKey).toBe('unreadable');
  });

  test('keylog status falls back to DB when gateway is down, reporting UNKNOWN', async () => {
    const { auth, user } = await openAuth();
    let code = -1;
    const result = await runMeshKeylogStatus(parsed, {
      auth,
      log() {},
      setExitCode: (value) => {
        code = value;
      },
      fetcher: async () => {
        throw new Error('connection refused');
      },
    });
    expect(result.local?.seq).toBe(2);
    expect(result.userId).toBe(user.userId);
    expect(result.remote).toBeNull();
    expect(result.verdict).toBe('UNKNOWN');
    expect(code).toBe(1);
  });

  test('keylog status uses loopback runtime surface and exits 2 on FORK', async () => {
    const { auth, user } = await openAuth();
    const head = auth.keyLogStore.head(user.userId)!;
    let code = -1;
    const logs: string[] = [];
    const result = await runMeshKeylogStatus(parsed, {
      auth,
      log: (line) => logs.push(line),
      setExitCode: (value) => {
        code = value;
      },
      fetcher: async (url) => {
        expect(String(url)).toBe('http://127.0.0.1:9883/api/mesh/keylog/status');
        return Response.json({
          userId: user.userId,
          local: { seq: 2, hash: encodeBase64url(head.hash) },
          remote: { seq: 2, hash: encodeBase64url(new Uint8Array(32)) },
          remoteKind: 'relay',
          localAtRemote: null,
          remoteAtLocal: null,
        });
      },
    });
    expect(result.verdict).toBe('FORK');
    expect(code).toBe(2);
    expect(logs).toContain('FORK');
  });
});

describe('keylog verdict', () => {
  const hash = encodeBase64url(new Uint8Array(32).fill(1));
  const other = encodeBase64url(new Uint8Array(32).fill(2));
  const base: MeshKeyLogStatus = {
    userId: 'user',
    local: { seq: 2, hash },
    remote: { seq: 2, hash },
    remoteKind: 'hub',
    localAtRemote: null,
    remoteAtLocal: null,
  };
  test('equal heads are in sync; equal seq with distinct hashes is a fork', () => {
    expect(keyLogStatusVerdict(base)).toBe('IN_SYNC');
    expect(keyLogStatusVerdict({ ...base, remote: { seq: 2, hash: other } })).toBe('FORK');
  });
  test('unequal seq compares the common prefix before reporting ahead or behind', () => {
    expect(
      keyLogStatusVerdict({ ...base, remote: { seq: 3, hash: other }, remoteAtLocal: hash })
    ).toBe('BEHIND');
    expect(
      keyLogStatusVerdict({ ...base, remote: { seq: 3, hash: other }, remoteAtLocal: other })
    ).toBe('FORK');
    expect(
      keyLogStatusVerdict({ ...base, remote: { seq: 1, hash: other }, localAtRemote: other })
    ).toBe('AHEAD');
    expect(
      keyLogStatusVerdict({ ...base, remote: { seq: 1, hash: other }, localAtRemote: hash })
    ).toBe('FORK');
  });
  test('missing prefix evidence is unknown, never claimed to be in sync', () => {
    expect(keyLogStatusVerdict({ ...base, remote: null })).toBe('UNKNOWN');
    expect(keyLogStatusVerdict({ ...base, remote: { seq: 3, hash } })).toBe('UNKNOWN');
    expect(keyLogStatusVerdict({ ...base, remote: { seq: 1, hash } })).toBe('UNKNOWN');
  });
});
