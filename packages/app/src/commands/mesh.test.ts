import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { parseArgs } from '../lib/args';
import { type LocalAuthContext, openLocalAuth } from '../lib/local-auth';
import { runHubUserAdd } from './hub';
import { runMeshResetRoot } from './mesh';

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
      env: { TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '', TMEX_ROLES: 'standalone' },
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
      env: { TMEX_MASTER_KEY: process.env.TMEX_MASTER_KEY || '', TMEX_ROLES: 'hub,node' },
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
  });
});
