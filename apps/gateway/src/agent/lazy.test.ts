import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from '../db/client';
import { markLiveServicesStopping, setLiveServicesEnabled } from '../live-start-gates';
import {
  ensureAgentSupervisor,
  isAgentSupervisorReady,
  loadAgentRuntime,
  resetAgentRuntimeLoaderForTests,
  startAgentSupervisor,
  stopAgentSupervisorIfLoaded,
} from './lazy';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

afterEach(async () => {
  await stopAgentSupervisorIfLoaded();
  setLiveServicesEnabled(false);
});

describe('agent/lazy', () => {
  test('loadAgentRuntime memoizes supervisor exports', async () => {
    const first = await loadAgentRuntime();
    const second = await loadAgentRuntime();
    expect(first).toBe(second);
    expect(typeof first.agentSupervisor.start).toBe('function');
    expect(first.agentSupervisor).toBe(second.agentSupervisor);
  });

  test('first load while live is disabled, then live enabled: start on demand', async () => {
    resetAgentRuntimeLoaderForTests();
    expect(isAgentSupervisorReady()).toBe(false);
    const supervisor = await ensureAgentSupervisor();
    expect(supervisor.isStarted()).toBe(false);
    expect(isAgentSupervisorReady()).toBe(true);

    setLiveServicesEnabled(true);
    expect(isAgentSupervisorReady()).toBe(false);
    await ensureAgentSupervisor();
    expect(supervisor.isStarted()).toBe(true);
    expect(isAgentSupervisorReady()).toBe(true);
  });

  test('in-process restart: stopped supervisor is started again on demand', async () => {
    setLiveServicesEnabled(true);
    const supervisor = await ensureAgentSupervisor();
    expect(supervisor.isStarted()).toBe(true);

    markLiveServicesStopping();
    await stopAgentSupervisorIfLoaded();
    expect(supervisor.isStarted()).toBe(false);

    setLiveServicesEnabled(true);
    expect(isAgentSupervisorReady()).toBe(false);
    await Promise.all([ensureAgentSupervisor(), ensureAgentSupervisor()]);
    expect(supervisor.isStarted()).toBe(true);
  });

  test('shutdown during the first load: stop waits for the load and nothing starts', async () => {
    resetAgentRuntimeLoaderForTests();
    setLiveServicesEnabled(true);
    const starting = startAgentSupervisor();
    markLiveServicesStopping();
    await stopAgentSupervisorIfLoaded();
    await starting;
    const { agentSupervisor } = await loadAgentRuntime();
    expect(agentSupervisor.isStarted()).toBe(false);
  });
});
