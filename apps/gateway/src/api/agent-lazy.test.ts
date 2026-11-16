import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { peekAgentRuntime, resetAgentRuntimeLoaderForTests } from '../agent/lazy';
import { ensureAgentSettingsInitialized } from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { createAgentRoutes } from './agent';
import { dispatchRoutes } from './route';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureAgentSettingsInitialized();
});

async function call(method: string, path: string): Promise<Response> {
  const routes = createAgentRoutes();
  const req = new Request(`http://localhost${path}`, { method });
  const response = await dispatchRoutes(req, path, routes, { path });
  if (!response) throw new Error(`no route matched: ${method} ${path}`);
  return response;
}

describe('agent routes with the lazy supervisor', () => {
  test('read routes answer without loading the supervisor; the first write loads it', async () => {
    resetAgentRuntimeLoaderForTests();
    const list = await call('GET', '/api/agent/sessions');
    expect(list.status).toBe(200);
    expect(peekAgentRuntime()).toBeUndefined();

    const stop = await call('POST', '/api/agent/sessions/missing-session/stop');
    expect(stop.status).toBe(404);
    const loaded = peekAgentRuntime();
    expect(loaded).toBeDefined();

    await call('POST', '/api/agent/sessions/missing-session/stop');
    expect(peekAgentRuntime()).toBe(loaded);
  });
});
