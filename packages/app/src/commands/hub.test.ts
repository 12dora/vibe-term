import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import { meshHubs } from '../../../../apps/gateway/src/db/schema';
import { HubRoleTransitionStore } from '../../../../apps/gateway/src/hub/hub-role-transitions';
import {
  bytesEqual,
  decodeKeyLogRecord,
  decodeSetTotpPayload,
  decryptTotpSecret,
  deriveSeed,
  deriveTotpKey,
  encodeAddPasskeyPayload,
  encodeBase64url,
  rootKeyFromSeed,
} from '../../../shared/src/auth';
import { setLang, t } from '../i18n';
import { parseArgs } from '../lib/args';
import { readEnvFile, stringifyEnv } from '../lib/env-file';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { deriveRootKey } from '../lib/password';
import {
  HUB_MANUAL_RESTART_HINT,
  HUB_SIGNED_AUTH_PRECEDENCE_NOTE,
  mapPasswdApplyError,
  runHubAllow,
  runHubDemote,
  runHubDisallow,
  runHubList,
  runHubPromote,
  runHubStandby,
  runHubUserAdd,
  runHubUserPasswd,
  runHubUserReset,
  runHubUserTotp,
} from './hub';

const MIGRATIONS = resolve(import.meta.dir, '../../../../apps/gateway/drizzle');
const parsed = parseArgs([]);

function must<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`missing ${label}`);
  return value;
}

function lastKeyLogType(auth: LocalAuthContext, userId: string): string {
  const logs = auth.keyLogStore.list(userId);
  const last = logs.at(-1);
  if (!last) throw new Error('empty key log');
  return decodeKeyLogRecord(last.bytes).type;
}

async function addTestPasskey(
  auth: LocalAuthContext,
  username: string,
  password: string
): Promise<void> {
  const user = must(auth.userStore.getByUsername(username), username);
  const rootKey = await deriveRootKey(password, kdfParamsFromJson(user.kdfParamsJson));
  const applied = await auth.userKeys.signAndApply(user.id, rootKey, {
    type: 'add-passkey',
    payload: encodeAddPasskeyPayload({
      credential_id: encodeBase64url(new Uint8Array(16).fill(8)),
      public_key: new Uint8Array(32).fill(1),
      rp_id: 'example.test',
      origin: 'https://example.test',
      counter: 0,
      transports: ['internal'],
      backup_eligible: false,
      backup_state: false,
      device_type: 'singleDevice',
      name: 'laptop',
    }),
  });
  if (!applied.ok) throw new Error(`add-passkey failed: ${applied.error}`);
}

async function openHubAuth(roles = 'hub,node'): Promise<LocalAuthContext> {
  return await openLocalAuth({
    memory: true,
    migrationsFolder: MIGRATIONS,
    env: {
      TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '',
      TMEX_ROLES: roles,
    },
  });
}

const authHandles: LocalAuthContext[] = [];

afterEach(() => {
  setLang('en');
  for (const ctx of authHandles.splice(0)) {
    ctx.close();
  }
});

describe('hub user commands', () => {
  test('hub user add writes genesis and self-signed admit-node identity', async () => {
    const auth = await openHubAuth();
    authHandles.push(auth);
    const result = await runHubUserAdd(parsed, 'alice', {
      auth,
      password: 'tmex-test-pass',
      log: () => undefined,
    });
    expect(result.userId).toBeTruthy();
    expect(result.fingerprint).toHaveLength(64);
    expect(result.rootEpoch).toBe(1);

    const user = must(auth.userStore.getByUsername('alice'), 'alice');
    const logs = auth.keyLogStore.list(user.id);
    expect(logs.map((row) => row.seq)).toEqual([1, 2]);
    expect(auth.userStore.listCertsByUser(user.id).length).toBe(1);
    const identity = await auth.identityStore.load();
    expect(identity?.nodeId).toBeTruthy();
    expect(identity?.userId).toBe(result.userId);
  });

  test('hub user passwd defaults to rotate-root-keep and rejects the old password', async () => {
    const auth = await openHubAuth();
    authHandles.push(auth);
    await runHubUserAdd(parsed, 'bob', {
      auth,
      password: 'old-pass-word',
      log: () => undefined,
    });
    const before = must(auth.userStore.getByUsername('bob'), 'bob');
    const logs: string[] = [];
    const rotated = await runHubUserPasswd(parsed, 'bob', {
      auth,
      oldPassword: 'old-pass-word',
      newPassword: 'new-pass-word',
      log: (message) => logs.push(message),
    });
    expect(rotated.rootEpoch).toBeGreaterThan(before.rootEpoch);
    expect(rotated.mode).toBe('keep');
    expect(lastKeyLogType(auth, before.id)).toBe('rotate-root-keep');
    expect(logs).toEqual([t('hub.user.passwd.doneKeep', { username: 'bob' })]);

    const after = must(auth.userStore.getByUsername('bob'), 'bob after rotate');
    const oldSeed = await deriveSeed('old-pass-word', kdfParamsFromJson(after.kdfParamsJson));
    expect(bytesEqual(rootKeyFromSeed(oldSeed).publicKey, after.rootPublicKey)).toBe(false);
    const newSeed = await deriveSeed('new-pass-word', kdfParamsFromJson(after.kdfParamsJson));
    expect(bytesEqual(rootKeyFromSeed(newSeed).publicKey, after.rootPublicKey)).toBe(true);

    await expect(
      runHubUserPasswd(parsed, 'bob', {
        auth,
        oldPassword: 'old-pass-word',
        newPassword: 'another',
        log: () => undefined,
      })
    ).rejects.toThrow(/password does not match/);
  });

  test('hub user passwd keep re-wraps TOTP and retains passkeys', async () => {
    const auth = await openHubAuth();
    authHandles.push(auth);
    await runHubUserAdd(parsed, 'bob', {
      auth,
      password: 'old-pass-word',
      log: () => undefined,
    });
    const enrolled = await runHubUserTotp(parsed, 'bob', {
      auth,
      password: 'old-pass-word',
      log: () => undefined,
    });
    await addTestPasskey(auth, 'bob', 'old-pass-word');
    const before = must(auth.userStore.getByUsername('bob'), 'bob');
    expect(before.totpRecordSeq).not.toBeNull();
    expect(auth.userStore.listKeysByUser(before.id)).toHaveLength(1);

    const rotated = await runHubUserPasswd(parsed, 'bob', {
      auth,
      oldPassword: 'old-pass-word',
      newPassword: 'new-pass-word',
      log: () => undefined,
    });
    expect(rotated.mode).toBe('keep');
    expect(lastKeyLogType(auth, before.id)).toBe('rotate-root-keep');

    const after = must(auth.userStore.getByUsername('bob'), 'bob after keep');
    expect(auth.userStore.listKeysByUser(after.id)).toHaveLength(1);
    expect(after.totpRecordSeq).toBe(after.keyLogHeadSeq);
    const state = auth.userKeys.currentState(after.id);
    expect(state.totp).toBeTruthy();
    const seed = await deriveSeed('new-pass-word', state.kdfParams);
    const kTotp = deriveTotpKey(seed, after.id, state.rootEpoch);
    const totpSeq = after.totpRecordSeq;
    if (totpSeq == null) throw new Error('missing totp seq');
    const plain = await decryptTotpSecret(kTotp, state.totp!, {
      uid: after.id,
      root_epoch: state.rootEpoch,
      seq: BigInt(totpSeq),
    });
    expect(bytesEqual(plain, enrolled.secret)).toBe(true);
  });

  test('hub user passwd --full-reset writes rotate-root and clears TOTP and passkeys', async () => {
    const auth = await openHubAuth();
    authHandles.push(auth);
    await runHubUserAdd(parsed, 'bob', {
      auth,
      password: 'old-pass-word',
      log: () => undefined,
    });
    await runHubUserTotp(parsed, 'bob', {
      auth,
      password: 'old-pass-word',
      log: () => undefined,
    });
    await addTestPasskey(auth, 'bob', 'old-pass-word');
    const before = must(auth.userStore.getByUsername('bob'), 'bob');
    const logs: string[] = [];
    const rotated = await runHubUserPasswd(
      parseArgs(['hub', 'user', 'passwd', 'bob', '--full-reset']),
      'bob',
      {
        auth,
        oldPassword: 'old-pass-word',
        newPassword: 'new-pass-word',
        log: (message) => logs.push(message),
      }
    );
    expect(rotated.mode).toBe('full-reset');
    expect(lastKeyLogType(auth, before.id)).toBe('rotate-root');
    expect(logs).toEqual([t('hub.user.passwd.doneFullReset', { username: 'bob' })]);

    const after = must(auth.userStore.getByUsername('bob'), 'bob after full-reset');
    expect(after.totpRecordSeq).toBeNull();
    expect(auth.userKeys.currentState(after.id).totp).toBeNull();
    expect(auth.userStore.listKeysByUser(after.id)).toEqual([]);
    const newSeed = await deriveSeed('new-pass-word', kdfParamsFromJson(after.kdfParamsJson));
    expect(bytesEqual(rootKeyFromSeed(newSeed).publicKey, after.rootPublicKey)).toBe(true);
  });

  test('hub user passwd maps hub apply errors in both languages', async () => {
    const cases = [
      ['HUB_TIMEOUT', 'hub.user.passwd.hubTimeout'],
      ['HUB_NOT_WRITER', 'hub.user.passwd.hubNotWriter'],
      ['KEYLOG_TYPE_UNSUPPORTED_BY_NODES', 'hub.user.passwd.nodesTooOld'],
    ] as const;
    for (const lang of ['en', 'zh-CN'] as const) {
      setLang(lang);
      for (const [code, key] of cases) {
        expect(mapPasswdApplyError(code)).toBe(t(key));
      }
    }

    const auth = await openHubAuth();
    authHandles.push(auth);
    await runHubUserAdd(parsed, 'bob', {
      auth,
      password: 'old-pass-word',
      log: () => undefined,
    });
    auth.userKeys.signAndApply = (async () => ({
      ok: false as const,
      error: 'HUB_TIMEOUT',
      // 真实链路上 hub 转发会带回这个码，服务层的返回类型没有覆盖它
    })) as unknown as typeof auth.userKeys.signAndApply;
    setLang('zh-CN');
    await expect(
      runHubUserPasswd(parsed, 'bob', {
        auth,
        oldPassword: 'old-pass-word',
        newPassword: 'new-pass-word',
        log: () => undefined,
      })
    ).rejects.toThrow(t('hub.user.passwd.hubTimeout'));
  });

  test('hub user totp record decrypts with deriveTotpKey', async () => {
    const auth = await openHubAuth();
    authHandles.push(auth);
    await runHubUserAdd(parsed, 'carol', {
      auth,
      password: 'totp-pass-word',
      log: () => undefined,
    });
    const enrolled = await runHubUserTotp(parsed, 'carol', {
      auth,
      password: 'totp-pass-word',
      log: () => undefined,
    });
    expect(enrolled.uri.startsWith('otpauth://totp/')).toBe(true);

    const user = must(auth.userStore.getByUsername('carol'), 'carol');
    const state = auth.userKeys.currentState(user.id);
    expect(state.totp).toBeTruthy();
    const seed = await deriveSeed('totp-pass-word', state.kdfParams);
    const kTotp = deriveTotpKey(seed, user.id, state.rootEpoch);
    const totpSeq = user.totpRecordSeq;
    if (totpSeq == null) throw new Error('missing totp seq');
    const entry = auth.keyLogStore.getAtSeq(user.id, totpSeq);
    if (!entry) throw new Error('missing totp record');
    const rec = decodeSetTotpPayload(decodeKeyLogRecord(entry.bytes).payload);
    const plain = await decryptTotpSecret(kTotp, rec, {
      uid: user.id,
      root_epoch: state.rootEpoch,
      seq: BigInt(totpSeq),
    });
    expect(bytesEqual(plain, enrolled.secret)).toBe(true);
  });

  test('hub user add refuses an existing username', async () => {
    const auth = await openHubAuth();
    authHandles.push(auth);
    await runHubUserAdd(parsed, 'alice', {
      auth,
      password: 'tmex-test-pass',
      log: () => undefined,
    });
    await expect(
      runHubUserAdd(parsed, 'alice', {
        auth,
        password: 'other-pass-word',
        log: () => undefined,
      })
    ).rejects.toThrow(/already exists/);
    expect(auth.userStore.getByUsername('alice')).toBeTruthy();
  });

  test('hub user reset wipes nodes and enrollment tokens', async () => {
    const auth = await openHubAuth();
    authHandles.push(auth);
    const added = await runHubUserAdd(parsed, 'dave', {
      auth,
      password: 'reset-pass-word',
      log: () => undefined,
    });
    auth.userStore.createNode({
      id: 'aa'.repeat(16),
      userId: added.userId,
      name: 'extra',
      now: Date.now(),
    });
    auth.userStore.createEnrollmentToken({
      id: crypto.randomUUID(),
      userId: added.userId,
      enrollPublicKey: new Uint8Array(32).fill(3),
      authorizationJson: '{}',
      authorizationSig: new Uint8Array(64),
      expiresAt: Date.now() + 60_000,
    });
    const events: string[] = [];
    const wiped = await runHubUserReset(parsed, {
      auth,
      log: () => undefined,
      skipRestart: true,
      stop: async () => {
        events.push('stop');
        expect(auth.userStore.listNodes().length).toBeGreaterThan(0);
      },
      restart: async () => {
        events.push('restart');
        expect(auth.userStore.listNodes()).toEqual([]);
      },
    });
    expect(wiped.wiped).toBeGreaterThan(0);
    expect(events).toEqual(['stop', 'restart']);
    expect(auth.userStore.listNodes()).toEqual([]);
    expect(auth.userStore.listCertsByUser(added.userId).length).toBe(1);
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function seedJoinedIdentity(
  auth: LocalAuthContext,
  hubUrl = 'https://hub.example'
): Promise<void> {
  await ensureNodeIdentity(auth.identityStore);
  const loaded = await auth.identityStore.load();
  if (!loaded) throw new Error('missing identity');
  await auth.identityStore.save({ ...loaded, hubUrl });
}

async function openEnvAuth(
  roles: string,
  extraEnv: Record<string, string> = {}
): Promise<{ auth: LocalAuthContext; envPath: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tmex-hub-cli-'));
  tempDirs.push(dir);
  const envPath = join(dir, 'app.env');
  const env = {
    TMEX_ROLES: roles,
    TMEX_HUB_URL: 'https://hub.example',
    ...extraEnv,
  };
  await writeFile(envPath, stringifyEnv(env), 'utf8');
  const auth = await openHubAuth(roles);
  authHandles.push(auth);
  auth.envPath = envPath;
  auth.installDir = dir;
  auth.env = env;
  return { auth, envPath, dir };
}

function insertMeshHub(
  auth: LocalAuthContext,
  row: {
    hubNodeId: string;
    publicUrl: string;
    name?: string | null;
    mode: 'active' | 'standby';
    priority: number;
    writerEpoch: number;
    online?: boolean;
    lastSeenAt?: number | null;
  }
): void {
  auth.db
    .insert(meshHubs)
    .values({
      hubNodeId: row.hubNodeId,
      publicUrl: row.publicUrl,
      name: row.name ?? null,
      mode: row.mode,
      priority: row.priority,
      writerEpoch: row.writerEpoch,
      caFingerprint: null,
      online: row.online ?? true,
      lastSeenAt: row.lastSeenAt ?? Date.now(),
      updatedAt: Date.now(),
    })
    .run();
}

describe('hub standby/promote/demote/list', () => {
  test('standby writes hub,node standby env and restarts', async () => {
    const { auth, envPath } = await openEnvAuth('node');
    await seedJoinedIdentity(auth);
    let restarted = 0;
    const result = await runHubStandby(
      parseArgs(['hub', 'standby', '--public-url', 'https://standby.example', '--priority', '50']),
      {
        auth,
        log: () => undefined,
        restart: async () => {
          restarted += 1;
        },
      }
    );
    expect(result.publicUrl).toBe('https://standby.example');
    expect(result.priority).toBe(50);
    expect(restarted).toBe(1);
    const env = await readEnvFile(envPath);
    expect(env.TMEX_ROLES).toBe('hub,node');
    expect(env.TMEX_HUB_MODE).toBe('standby');
    expect(env.TMEX_HUB_PUBLIC_URL).toBe('https://standby.example');
    expect(env.TMEX_HUB_PRIORITY).toBe('50');
    expect(env.TMEX_HUB_URL).toBe('https://hub.example');
  });

  test('standby defaults priority to 200', async () => {
    const { auth, envPath } = await openEnvAuth('node');
    await seedJoinedIdentity(auth);
    await runHubStandby(parseArgs(['hub', 'standby', '--public-url', 'https://standby.example']), {
      auth,
      log: () => undefined,
      skipRestart: true,
    });
    expect((await readEnvFile(envPath)).TMEX_HUB_PRIORITY).toBe('200');
  });

  test('standby refuses when the node is not joined', async () => {
    const { auth, envPath } = await openEnvAuth('standalone');
    await expect(
      runHubStandby(parseArgs(['hub', 'standby', '--public-url', 'https://standby.example']), {
        auth,
        log: () => undefined,
        skipRestart: true,
      })
    ).rejects.toThrow(/node_identity|尚未加入|not joined/i);
    expect((await readEnvFile(envPath)).TMEX_ROLES).toBe('standalone');
  });

  test('standby refuses an active hub,node and tells the user to demote first', async () => {
    const { auth, envPath } = await openEnvAuth('hub,node', { TMEX_HUB_MODE: 'active' });
    await seedJoinedIdentity(auth);
    await expect(
      runHubStandby(parseArgs(['hub', 'standby', '--public-url', 'https://standby.example']), {
        auth,
        log: () => undefined,
        skipRestart: true,
      })
    ).rejects.toThrow(/demote/i);
    expect((await readEnvFile(envPath)).TMEX_HUB_MODE).toBe('active');
  });

  test('standby refuses http public url without --insecure-local', async () => {
    const { auth } = await openEnvAuth('node');
    await seedJoinedIdentity(auth);
    await expect(
      runHubStandby(parseArgs(['hub', 'standby', '--public-url', 'http://standby.example']), {
        auth,
        log: () => undefined,
        skipRestart: true,
      })
    ).rejects.toThrow(/https/i);
  });

  test('promote requires --yes or interactive confirmation, then bumps writerEpoch', async () => {
    const { auth, envPath } = await openEnvAuth('hub,node', {
      TMEX_HUB_MODE: 'standby',
      TMEX_HUB_WRITER_EPOCH: '3',
    });
    await seedJoinedIdentity(auth);
    insertMeshHub(auth, {
      hubNodeId: 'aa'.repeat(16),
      publicUrl: 'https://writer.example',
      name: 'writer',
      mode: 'active',
      priority: 100,
      writerEpoch: 5,
    });
    insertMeshHub(auth, {
      hubNodeId: 'bb'.repeat(16),
      publicUrl: 'https://standby.example',
      name: 'standby',
      mode: 'standby',
      priority: 200,
      writerEpoch: 2,
    });

    await expect(
      runHubPromote(parseArgs(['hub', 'promote']), {
        auth,
        log: () => undefined,
        skipRestart: true,
        confirm: async () => false,
      })
    ).rejects.toThrow(/cancel|取消/i);
    expect((await readEnvFile(envPath)).TMEX_HUB_MODE).toBe('standby');

    const logs: string[] = [];
    let restarted = 0;
    const promoted = await runHubPromote(parseArgs(['hub', 'promote', '--yes']), {
      auth,
      log: (message) => logs.push(message),
      restart: async () => {
        restarted += 1;
      },
    });
    expect(promoted.writerEpoch).toBe(6);
    expect(restarted).toBe(1);
    const env = await readEnvFile(envPath);
    expect(env.TMEX_HUB_MODE).toBe('active');
    expect(env.TMEX_HUB_WRITER_EPOCH).toBe('6');
    expect(logs.some((line) => /split-brain|脑裂/i.test(line))).toBe(true);
    expect(logs.some((line) => line.includes('\u001b[31m'))).toBe(true);
  });

  test('promote falls back to env+1 when mesh_hubs is unreadable', async () => {
    const { auth, envPath } = await openEnvAuth('hub,node', {
      TMEX_HUB_MODE: 'standby',
      TMEX_HUB_WRITER_EPOCH: '4',
    });
    await seedJoinedIdentity(auth);
    const sqlite = auth.sqlite as { exec?: (sql: string) => void };
    sqlite.exec?.('drop table if exists mesh_hubs');
    const promoted = await runHubPromote(parseArgs(['hub', 'promote', '--yes']), {
      auth,
      log: () => undefined,
      skipRestart: true,
    });
    expect(promoted.writerEpoch).toBe(5);
    expect((await readEnvFile(envPath)).TMEX_HUB_WRITER_EPOCH).toBe('5');
  });

  test('promote refuses a node-only install', async () => {
    const { auth } = await openEnvAuth('node');
    await seedJoinedIdentity(auth);
    await expect(
      runHubPromote(parseArgs(['hub', 'promote', '--yes']), {
        auth,
        log: () => undefined,
        skipRestart: true,
      })
    ).rejects.toThrow(/hub,node/);
  });

  test('demote sets TMEX_HUB_MODE=standby and restarts', async () => {
    const { auth, envPath } = await openEnvAuth('hub,node', { TMEX_HUB_MODE: 'active' });
    await seedJoinedIdentity(auth);
    let restarted = 0;
    await runHubDemote(parseArgs(['hub', 'demote']), {
      auth,
      log: () => undefined,
      restart: async () => {
        restarted += 1;
      },
    });
    expect(restarted).toBe(1);
    expect((await readEnvFile(envPath)).TMEX_HUB_MODE).toBe('standby');
  });

  test('list prints mesh_hubs and marks the writer', async () => {
    const { auth } = await openEnvAuth('node');
    insertMeshHub(auth, {
      hubNodeId: 'aa'.repeat(16),
      publicUrl: 'https://old.example',
      name: 'old',
      mode: 'active',
      priority: 10,
      writerEpoch: 1,
      online: false,
      lastSeenAt: 1_700_000_000_000,
    });
    insertMeshHub(auth, {
      hubNodeId: 'cc'.repeat(16),
      publicUrl: 'https://writer.example',
      name: 'writer',
      mode: 'active',
      priority: 50,
      writerEpoch: 9,
      online: true,
      lastSeenAt: 1_700_000_100_000,
    });
    insertMeshHub(auth, {
      hubNodeId: 'bb'.repeat(16),
      publicUrl: 'https://standby.example',
      name: 'spare',
      mode: 'standby',
      priority: 200,
      writerEpoch: 3,
      online: true,
      lastSeenAt: null,
    });
    const logs: string[] = [];
    const listed = await runHubList(parseArgs(['hub', 'list']), {
      auth,
      log: (message) => logs.push(message),
    });
    expect(listed.writerHubId).toBe('cc'.repeat(16));
    const writer = listed.hubs.find((row) => row.hubNodeId === 'cc'.repeat(16));
    expect(writer?.writer).toBe(true);
    expect(listed.hubs.find((row) => row.hubNodeId === 'aa'.repeat(16))?.writer).toBe(false);
    const text = logs.join('\n');
    expect(text).toContain('writer.example');
    expect(text).toContain('standby');
    expect(text).toMatch(/\*/);
  });

  test('standby prints local node id and the active-hub allow command', async () => {
    const { auth } = await openEnvAuth('node');
    await seedJoinedIdentity(auth);
    const identity = await auth.identityStore.load();
    if (!identity) throw new Error('missing identity');
    const logs: string[] = [];
    const result = await runHubStandby(
      parseArgs(['hub', 'standby', '--public-url', 'https://standby.example']),
      {
        auth,
        log: (message) => logs.push(message),
        skipRestart: true,
      }
    );
    expect(result.nodeId).toBe(identity.nodeId);
    const text = logs.join('\n');
    expect(text).toContain(identity.nodeId);
    expect(text).toContain(`tmex hub allow ${identity.nodeId}`);
    expect(text).toMatch(/ignore|忽略/i);
  });

  test('standby auto-authorizes the current primary from mesh_hubs active rows', async () => {
    const primary = 'aa'.repeat(16);
    const { auth, envPath } = await openEnvAuth('node');
    await seedJoinedIdentity(auth);
    insertMeshHub(auth, {
      hubNodeId: primary,
      publicUrl: 'https://hub.example',
      name: 'writer',
      mode: 'active',
      priority: 100,
      writerEpoch: 4,
    });
    const logs: string[] = [];
    await runHubStandby(parseArgs(['hub', 'standby', '--public-url', 'https://standby.example']), {
      auth,
      log: (message) => logs.push(message),
      skipRestart: true,
    });
    expect((await readEnvFile(envPath)).TMEX_HUB_PEERS).toBe(primary);
    expect(logs.join('\n')).toContain(primary);
  });

  test('standby falls back to the peer_cache hub sentinel when mesh_hubs has no active row', async () => {
    const primary = 'bb'.repeat(16);
    const { auth, envPath } = await openEnvAuth('node');
    await seedJoinedIdentity(auth);
    auth.userStore.upsertHubMeta({
      nodeId: primary,
      publicUrl: 'https://hub.example',
      now: Date.now(),
    });
    const logs: string[] = [];
    await runHubStandby(parseArgs(['hub', 'standby', '--public-url', 'https://standby.example']), {
      auth,
      log: (message) => logs.push(message),
      skipRestart: true,
    });
    expect((await readEnvFile(envPath)).TMEX_HUB_PEERS).toBe(primary);
    expect(logs.join('\n')).toContain(primary);
  });

  test('standby warns when no primary hub id can be found', async () => {
    const { auth, envPath } = await openEnvAuth('node');
    await seedJoinedIdentity(auth);
    const logs: string[] = [];
    await runHubStandby(parseArgs(['hub', 'standby', '--public-url', 'https://standby.example']), {
      auth,
      log: (message) => logs.push(message),
      skipRestart: true,
    });
    expect((await readEnvFile(envPath)).TMEX_HUB_PEERS).toBeUndefined();
    expect(logs.join('\n')).toMatch(/WARNING|警告/);
  });

  test('promote and demote print TMEX_HUB_PEERS without changing it', async () => {
    const keep = 'cc'.repeat(16);
    const { auth, envPath } = await openEnvAuth('hub,node', {
      TMEX_HUB_MODE: 'standby',
      TMEX_HUB_PEERS: keep,
    });
    await seedJoinedIdentity(auth);
    const promoteLogs: string[] = [];
    await runHubPromote(parseArgs(['hub', 'promote', '--yes']), {
      auth,
      log: (message) => promoteLogs.push(message),
      skipRestart: true,
    });
    expect((await readEnvFile(envPath)).TMEX_HUB_PEERS).toBe(keep);
    expect(promoteLogs.join('\n')).toContain(keep);

    const demoteLogs: string[] = [];
    await runHubDemote(parseArgs(['hub', 'demote']), {
      auth,
      log: (message) => demoteLogs.push(message),
      skipRestart: true,
    });
    expect((await readEnvFile(envPath)).TMEX_HUB_PEERS).toBe(keep);
    expect(demoteLogs.join('\n')).toContain(keep);
  });

  test('promote warns when TMEX_HUB_PEERS is empty and reminds the old writer', async () => {
    const { auth } = await openEnvAuth('hub,node', { TMEX_HUB_MODE: 'standby' });
    await seedJoinedIdentity(auth);
    const identity = await auth.identityStore.load();
    if (!identity) throw new Error('missing identity');
    const logs: string[] = [];
    await runHubPromote(parseArgs(['hub', 'promote', '--yes']), {
      auth,
      log: (message) => logs.push(message),
      skipRestart: true,
    });
    const text = logs.join('\n');
    expect(text).toMatch(/TMEX_HUB_PEERS/);
    expect(text).toMatch(/empty|空/i);
    expect(text).toContain(`tmex hub allow ${identity.nodeId}`);
  });

  test('list marks authorized for self and TMEX_HUB_PEERS, not others', async () => {
    const { auth } = await openEnvAuth('hub,node', {
      TMEX_HUB_PEERS: 'ab'.repeat(16),
    });
    await seedJoinedIdentity(auth);
    const identity = await auth.identityStore.load();
    if (!identity) throw new Error('missing identity');
    insertMeshHub(auth, {
      hubNodeId: identity.nodeId,
      publicUrl: 'https://self.example',
      name: 'self',
      mode: 'standby',
      priority: 200,
      writerEpoch: 1,
    });
    insertMeshHub(auth, {
      hubNodeId: 'ab'.repeat(16),
      publicUrl: 'https://peer.example',
      name: 'peer',
      mode: 'active',
      priority: 100,
      writerEpoch: 4,
    });
    insertMeshHub(auth, {
      hubNodeId: 'cd'.repeat(16),
      publicUrl: 'https://other.example',
      name: 'other',
      mode: 'standby',
      priority: 300,
      writerEpoch: 1,
    });
    const logs: string[] = [];
    const listed = await runHubList(parseArgs(['hub', 'list']), {
      auth,
      log: (message) => logs.push(message),
    });
    expect(listed.hubs.find((row) => row.hubNodeId === identity.nodeId)?.authorization).toBe(
      'self'
    );
    expect(listed.hubs.find((row) => row.hubNodeId === 'ab'.repeat(16))?.authorization).toBe('env');
    expect(listed.hubs.find((row) => row.hubNodeId === 'cd'.repeat(16))?.authorization).toBe('no');
    const text = logs.join('\n');
    expect(text).toMatch(/AUTH|authorized/i);
    expect(text).toContain('self');
    expect(text).toContain('env');
    expect(text).toContain('no');
  });

  test('promote/demote persist hub_role_transitions; list prints latest phase', async () => {
    const { auth } = await openEnvAuth('hub,node', { TMEX_HUB_MODE: 'standby' });
    await seedJoinedIdentity(auth);
    await runHubPromote(parseArgs(['hub', 'promote', '--yes']), {
      auth,
      log: () => undefined,
      skipRestart: true,
    });
    const afterPromote = new HubRoleTransitionStore(auth.db).latest();
    expect(afterPromote?.mode).toBe('active');
    expect(afterPromote?.phase).toBe('restarting');
    expect(afterPromote?.writerEpoch).toBeGreaterThanOrEqual(2);

    await runHubDemote(parseArgs(['hub', 'demote']), {
      auth,
      log: () => undefined,
      skipRestart: true,
    });
    const afterDemote = new HubRoleTransitionStore(auth.db).latest();
    expect(afterDemote?.mode).toBe('standby');
    expect(afterDemote?.phase).toBe('restarting');

    const logs: string[] = [];
    await runHubList(parseArgs(['hub', 'list']), {
      auth,
      log: (message) => logs.push(message),
    });
    expect(logs.join('\n')).toContain(`role-transition restarting ${afterDemote?.operationId}`);
  });
});

describe('hub allow/disallow', () => {
  test('allow validates 32-hex, de-dups keeping order, writes TMEX_HUB_PEERS, and restarts', async () => {
    const first = 'aa'.repeat(16);
    const second = 'bb'.repeat(16);
    const third = 'cc'.repeat(16);
    const { auth, envPath } = await openEnvAuth('hub,node', {
      TMEX_HUB_PEERS: `${second},${first}`,
    });
    let restarted = 0;
    const logs: string[] = [];
    const result = await runHubAllow(
      parseArgs(['hub', 'allow']),
      [first.toUpperCase(), third, third, second],
      {
        auth,
        log: (message) => logs.push(message),
        restart: async () => {
          restarted += 1;
        },
      }
    );
    expect(result.peers).toEqual([second, first, third]);
    expect(restarted).toBe(1);
    expect((await readEnvFile(envPath)).TMEX_HUB_PEERS).toBe(`${second},${first},${third}`);
    const text = logs.join('\n');
    expect(text).toContain(second);
    expect(text).toContain(first);
    expect(text).toContain(third);
    expect(text).toContain(HUB_SIGNED_AUTH_PRECEDENCE_NOTE);
  });

  test('allow refuses invalid node ids and does not write env', async () => {
    const { auth, envPath } = await openEnvAuth('hub,node');
    await expect(
      runHubAllow(parseArgs(['hub', 'allow']), ['not-a-node-id'], {
        auth,
        log: () => undefined,
        skipRestart: true,
      })
    ).rejects.toThrow(/32|hex|node id/i);
    expect((await readEnvFile(envPath)).TMEX_HUB_PEERS).toBeUndefined();
  });

  test('allow refuses a node-only install', async () => {
    const { auth, envPath } = await openEnvAuth('node');
    await expect(
      runHubAllow(parseArgs(['hub', 'allow']), ['aa'.repeat(16)], {
        auth,
        log: () => undefined,
        skipRestart: true,
      })
    ).rejects.toThrow(/hub,node/);
    expect((await readEnvFile(envPath)).TMEX_HUB_PEERS).toBeUndefined();
  });

  test('allow --no-restart skips restart', async () => {
    const { auth, envPath } = await openEnvAuth('hub,node');
    let restarted = 0;
    const logs: string[] = [];
    await runHubAllow(parseArgs(['hub', 'allow', '--no-restart']), ['dd'.repeat(16)], {
      auth,
      log: (message) => logs.push(message),
      restart: async () => {
        restarted += 1;
      },
    });
    expect(restarted).toBe(0);
    expect((await readEnvFile(envPath)).TMEX_HUB_PEERS).toBe('dd'.repeat(16));
    expect(logs.join('\n')).toContain(HUB_MANUAL_RESTART_HINT);
  });

  test('disallow removes the id, prints the list, and refuses non-hub', async () => {
    const keep = 'aa'.repeat(16);
    const drop = 'bb'.repeat(16);
    const { auth, envPath } = await openEnvAuth('hub,node', {
      TMEX_HUB_PEERS: `${keep},${drop}`,
    });
    const logs: string[] = [];
    const result = await runHubDisallow(parseArgs(['hub', 'disallow']), drop, {
      auth,
      log: (message) => logs.push(message),
      skipRestart: true,
    });
    expect(result.peers).toEqual([keep]);
    expect((await readEnvFile(envPath)).TMEX_HUB_PEERS).toBe(keep);
    expect(logs.join('\n')).toContain(keep);
    expect(logs.join('\n')).not.toContain(drop);

    const nodeOnly = await openEnvAuth('node', { TMEX_HUB_PEERS: keep });
    await expect(
      runHubDisallow(parseArgs(['hub', 'disallow']), keep, {
        auth: nodeOnly.auth,
        log: () => undefined,
        skipRestart: true,
      })
    ).rejects.toThrow(/hub,node/);
    expect((await readEnvFile(nodeOnly.envPath)).TMEX_HUB_PEERS).toBe(keep);
  });
});
