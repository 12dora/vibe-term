import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HubTrustStore } from '../../../../apps/gateway/src/auth/hub-trust-store';
import { MeshMembershipStore } from '../../../../apps/gateway/src/auth/mesh-membership-store';
import { MeshRelayStore } from '../../../../apps/gateway/src/auth/mesh-relay-store';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import {
  enrollmentTokens,
  hubTrust,
  meshRelays,
  meshSecrets,
  nodeCerts,
  nodeIdentity,
  nodeSessions,
  nodes,
  peerCache,
  userKeyLog,
  userKeys,
  users,
} from '../../../../apps/gateway/src/db/schema';
import { readEnvFile } from '../lib/env-file';
import type { LocalAuthContext } from '../lib/local-auth';
import { openLocalAuth } from '../lib/local-auth';
import { leaveMesh } from './membership-reset';
import {
  SetupError,
  type SetupServiceDeps,
  createSetupTransitionLock,
  resetProcessSetupLockForTests,
} from './setup-service';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const authHandles: LocalAuthContext[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  resetProcessSetupLockForTests();
  for (const ctx of authHandles.splice(0)) ctx.close();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function openAuth(roles = 'node'): Promise<LocalAuthContext> {
  const ctx = await openLocalAuth({
    memory: true,
    migrationsFolder: MIGRATIONS,
    env: {
      TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
      TMEX_ROLES: roles,
    },
  });
  authHandles.push(ctx);
  return ctx;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tmex-leave-'));
  tempDirs.push(dir);
  return dir;
}

async function seedMembership(auth: LocalAuthContext): Promise<void> {
  const identity = await ensureNodeIdentity(auth.identityStore);
  await auth.userKeys.bootstrapUserWithSelfAdmit({
    username: 'alice',
    password: 'tmex-test-pass',
    identity,
    now: 1_700_000_000_000,
  });
  const user = auth.userStore.getByUsername('alice');
  if (!user) throw new Error('expected alice');
  auth.userStore.upsertPeer({
    nodeId: 'peer-1',
    name: 'studio',
    endpointsJson: '[]',
    inventoryJson: '{}',
    directCapable: false,
    lastSeenAt: 10,
    listVersion: 1,
  });
  new HubTrustStore(auth.db).put({
    hubUrl: 'https://hub.example',
    caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    fingerprint: 'ab'.repeat(32),
  });
  auth.userStore.createEnrollmentToken({
    id: 'tok-leave',
    userId: user.id,
    enrollPublicKey: Uint8Array.from({ length: 32 }, () => 9),
    authorizationJson: '{}',
    authorizationSig: Uint8Array.from({ length: 64 }, () => 3),
    expiresAt: 9_999_999_999,
  });
}

/** 造出「已接入中继」的落库状态：目标行 + K_log / K_meta + uplink_kind。 */
async function seedRelayAttachment(auth: LocalAuthContext): Promise<void> {
  const store = new MeshRelayStore(auth.db);
  await store.replaceRelays(
    [
      {
        url: 'https://relay.example',
        tenantId: 'ab'.repeat(16),
        token: Uint8Array.from({ length: 32 }, () => 7),
        priority: 0,
      },
    ],
    1_700_000_000_000
  );
  await store.putSecret(
    'log',
    0,
    Uint8Array.from({ length: 32 }, () => 1),
    1_700_000_000_000
  );
  await store.putSecret(
    'meta',
    1,
    Uint8Array.from({ length: 32 }, () => 2),
    1_700_000_000_000
  );
  store.setUplinkKind('relay');
  store.setLocalName('studio');
}

async function baseDeps(overrides: Partial<SetupServiceDeps> = {}): Promise<SetupServiceDeps> {
  const dir = await tempDir();
  const envPath = join(dir, 'app.env');
  await writeFile(
    envPath,
    'TMEX_ROLES=node\nTMEX_HUB_URL=https://hub.example\nTMEX_HUB_PUBLIC_URL=https://stale.example\nOTHER=keep\n',
    'utf8'
  );
  const auth = overrides.auth ?? (await openAuth());
  await seedMembership(auth);
  return {
    roles: { hub: false, node: true, relay: false },
    nodeEnv: 'test',
    auth,
    envPath,
    installDir: dir,
    scheduleRestart: () => undefined,
    setupLock: createSetupTransitionLock(),
    ...overrides,
  };
}

describe('leaveMesh', () => {
  test('clears membership tables, writes standalone env, and schedules restart', async () => {
    const restarts: number[] = [];
    const deps = await baseDeps({
      scheduleRestart: () => {
        restarts.push(1);
      },
    });
    const result = await leaveMesh({ expectedRole: 'node' }, deps);
    expect(result).toEqual({ ok: true, fromRole: 'node', restarting: true });
    expect(restarts).toEqual([1]);
    expect(deps.auth.userStore.listUsers()).toHaveLength(0);
    expect(deps.auth.userStore.listNodes()).toHaveLength(0);
    expect(deps.auth.userStore.listPeers()).toHaveLength(0);
    expect(deps.auth.userStore.listCerts()).toHaveLength(0);
    expect(deps.auth.db.select().from(userKeyLog).all()).toHaveLength(0);
    expect(deps.auth.db.select().from(userKeys).all()).toHaveLength(0);
    expect(deps.auth.db.select().from(nodeSessions).all()).toHaveLength(0);
    expect(deps.auth.db.select().from(nodeCerts).all()).toHaveLength(0);
    expect(deps.auth.db.select().from(nodes).all()).toHaveLength(0);
    expect(deps.auth.db.select().from(enrollmentTokens).all()).toHaveLength(0);
    expect(deps.auth.db.select().from(peerCache).all()).toHaveLength(0);
    expect(deps.auth.db.select().from(hubTrust).all()).toHaveLength(0);
    expect(deps.auth.db.select().from(nodeIdentity).all()).toHaveLength(0);
    expect(deps.auth.db.select().from(users).all()).toHaveLength(0);
    expect(await deps.auth.identityStore.load()).toBeNull();
    const env = await readEnvFile(deps.envPath);
    expect(env.TMEX_ROLES).toBe('standalone');
    expect(env.TMEX_HUB_URL).toBe('');
    expect(env.TMEX_HUB_PUBLIC_URL).toBe('');
    expect(env.OTHER).toBe('keep');
    const envText = await readFile(deps.envPath, 'utf8');
    expect(envText).toContain('TMEX_HUB_URL=\n');
    expect(envText).toContain('TMEX_HUB_PUBLIC_URL=\n');
  });

  test('relay,node 可以退出：中继令牌与租户密钥一并清空', async () => {
    const deps = await baseDeps({ roles: { hub: false, node: true, relay: true } });
    await seedRelayAttachment(deps.auth);
    expect(deps.auth.db.select().from(meshRelays).all()).toHaveLength(1);
    const result = await leaveMesh({ expectedRole: 'relay,node' }, deps);
    expect(result).toEqual({ ok: true, fromRole: 'relay,node', restarting: true });
    // 租户令牌 / K_log / K_meta 一条都不能留在盘上
    expect(deps.auth.db.select().from(meshRelays).all()).toHaveLength(0);
    expect(deps.auth.db.select().from(meshSecrets).all()).toHaveLength(0);
    // uplink_kind / name 随 node_identity 整行删除
    expect(deps.auth.db.select().from(nodeIdentity).all()).toHaveLength(0);
    expect(deps.auth.userStore.listUsers()).toHaveLength(0);
    expect((await readEnvFile(deps.envPath)).TMEX_ROLES).toBe('standalone');
  });

  test('纯 relay 没有成员身份：400 not_member 且不清库', async () => {
    const deps = await baseDeps({ roles: { hub: false, node: false, relay: true } });
    await seedRelayAttachment(deps.auth);
    const err = await leaveMesh({ expectedRole: 'relay,node' }, deps).catch((error) => error);
    expect(err).toBeInstanceOf(SetupError);
    expect((err as SetupError).code).toBe('not_member');
    expect((err as SetupError).httpStatus).toBe(400);
    expect(deps.auth.userStore.getByUsername('alice')).toBeTruthy();
    expect(deps.auth.db.select().from(meshRelays).all()).toHaveLength(1);
    expect((await readEnvFile(deps.envPath)).TMEX_ROLES).toBe('node');
  });

  test('relay,node 报成 node 时仍是 409 role_mismatch', async () => {
    const deps = await baseDeps({ roles: { hub: false, node: true, relay: true } });
    await seedRelayAttachment(deps.auth);
    const err = await leaveMesh({ expectedRole: 'node' }, deps).catch((error) => error);
    expect((err as SetupError).code).toBe('role_mismatch');
    expect((err as SetupError).httpStatus).toBe(409);
    expect(deps.auth.db.select().from(meshRelays).all()).toHaveLength(1);
  });

  test('hub,node expectedRole matches and returns fromRole', async () => {
    const deps = await baseDeps({ roles: { hub: true, node: true, relay: false } });
    const result = await leaveMesh({ expectedRole: 'hub,node' }, deps);
    expect(result.fromRole).toBe('hub,node');
  });

  test('standalone is 400 not_member', async () => {
    const deps = await baseDeps({ roles: { hub: false, node: false, relay: false } });
    const err = await leaveMesh({ expectedRole: 'node' }, deps).catch((error) => error);
    expect(err).toBeInstanceOf(SetupError);
    expect((err as SetupError).code).toBe('not_member');
    expect((err as SetupError).httpStatus).toBe(400);
    expect(deps.auth.userStore.getByUsername('alice')).toBeTruthy();
  });

  test('wrong expectedRole is 409 role_mismatch and does not wipe', async () => {
    const deps = await baseDeps({ roles: { hub: false, node: true, relay: false } });
    const err = await leaveMesh({ expectedRole: 'hub,node' }, deps).catch((error) => error);
    expect(err).toBeInstanceOf(SetupError);
    expect((err as SetupError).code).toBe('role_mismatch');
    expect((err as SetupError).httpStatus).toBe(409);
    expect(deps.auth.userStore.getByUsername('alice')).toBeTruthy();
    expect((await readEnvFile(deps.envPath)).TMEX_ROLES).toBe('node');
  });

  test('setup_in_progress when another transition holds the lock', async () => {
    const lock = createSetupTransitionLock();
    lock.begin();
    const deps = await baseDeps({ setupLock: lock });
    const err = await leaveMesh({ expectedRole: 'node' }, deps).catch((error) => error);
    expect(err).toBeInstanceOf(SetupError);
    expect((err as SetupError).code).toBe('setup_in_progress');
    expect((err as SetupError).httpStatus).toBe(409);
    lock.finish(false);
  });

  test('env_write_failed does not restart and leaves membership intact', async () => {
    const restarts: number[] = [];
    const deps = await baseDeps({
      scheduleRestart: () => {
        restarts.push(1);
      },
      writeEnvFile: async () => {
        throw new Error('EACCES');
      },
      writeStagedEnvFile: async () => {
        throw new Error('EACCES');
      },
    });
    const err = await leaveMesh({ expectedRole: 'node' }, deps).catch((error) => error);
    expect(err).toBeInstanceOf(SetupError);
    expect((err as SetupError).code).toBe('env_write_failed');
    expect((err as SetupError).httpStatus).toBe(500);
    expect(restarts).toEqual([]);
    expect(deps.auth.userStore.getByUsername('alice')).toBeTruthy();
    expect(deps.auth.userStore.listUsers()).toHaveLength(1);
    expect(deps.auth.db.select().from(users).all()).toHaveLength(1);
    expect((await readEnvFile(deps.envPath)).TMEX_ROLES).toBe('node');
  });

  test('database failure leaves env untouched and removes the staged file', async () => {
    const orig = MeshMembershipStore.prototype.clearAll;
    MeshMembershipStore.prototype.clearAll = () => {
      throw new Error('SQLITE_BUSY');
    };
    try {
      const deps = await baseDeps();
      const err = await leaveMesh({ expectedRole: 'node' }, deps).catch((error) => error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('SQLITE_BUSY');
      expect(deps.auth.userStore.getByUsername('alice')).toBeTruthy();
      expect((await readEnvFile(deps.envPath)).TMEX_ROLES).toBe('node');
      expect((await readEnvFile(deps.envPath)).TMEX_HUB_URL).toBe('https://hub.example');
      const leftovers = (await readdir(dirname(deps.envPath))).filter((name) =>
        name.endsWith('.tmp')
      );
      expect(leftovers).toEqual([]);
    } finally {
      MeshMembershipStore.prototype.clearAll = orig;
    }
  });

  test('quiesceMesh is best-effort and does not fail leave', async () => {
    let called = 0;
    const deps = await baseDeps({
      quiesceMesh: () => {
        called += 1;
        throw new Error('uplink already gone');
      },
    });
    const result = await leaveMesh({ expectedRole: 'node' }, deps);
    expect(result.ok).toBe(true);
    expect(called).toBe(1);
    expect(deps.auth.userStore.listUsers()).toHaveLength(0);
  });
});
