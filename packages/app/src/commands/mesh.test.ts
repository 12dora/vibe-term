import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { parseArgs } from '../lib/args';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { runHubUserAdd } from './hub';
import { runMeshPasskeyRemoveAll, runMeshResetRoot } from './mesh';

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

    const reset = await runMeshResetRoot(parsed, {
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
