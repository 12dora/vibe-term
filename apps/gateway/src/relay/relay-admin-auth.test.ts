import { afterEach, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../auth/test-db';
import { ensureRelayAdminToken } from './relay-admin-auth';
import { RelayConfigStore } from './relay-config-store';

const dbs: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function freshStore(): RelayConfigStore {
  const handle = createMigratedAuthDb();
  dbs.push(handle);
  return new RelayConfigStore(handle.db);
}

describe('ensureRelayAdminToken logging', () => {
  test('persisted token is never written to the log', async () => {
    const lines: string[] = [];
    const token = await ensureRelayAdminToken({
      configuredToken: null,
      store: freshStore(),
      now: () => 1_000,
      patchEnv: async () => {},
      log: (line) => lines.push(line),
    });
    expect(token).toBeTruthy();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('VIBETERM_RELAY_ADMIN_TOKEN in app.env');
    for (const line of lines) expect(line).not.toContain(token ?? '');
  });

  test('unpersisted token is never written to the log', async () => {
    const lines: string[] = [];
    const token = await ensureRelayAdminToken({
      configuredToken: null,
      store: freshStore(),
      now: () => 1_000,
      log: (line) => lines.push(line),
    });
    expect(token).toBeTruthy();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(token ?? '');
  });

  test('patchEnv failure logs neither the token nor the patch', async () => {
    const lines: string[] = [];
    const token = await ensureRelayAdminToken({
      configuredToken: null,
      store: freshStore(),
      now: () => 1_000,
      patchEnv: async () => {
        throw new Error('EACCES: app.env');
      },
      log: (line) => lines.push(line),
    });
    expect(token).toBeTruthy();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('failed to persist');
    for (const line of lines) expect(line).not.toContain(token ?? '');
  });

  test('configured token is used silently', async () => {
    const lines: string[] = [];
    const token = await ensureRelayAdminToken({
      configuredToken: 'configured-admin-token',
      store: freshStore(),
      now: () => 1_000,
      log: (line) => lines.push(line),
    });
    expect(token).toBe('configured-admin-token');
    expect(lines).toEqual([]);
  });
});
