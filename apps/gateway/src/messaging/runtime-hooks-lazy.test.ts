import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { peekAgentRuntime, resetAgentRuntimeLoaderForTests } from '../agent/lazy';
import { agentSupervisor } from '../agent/supervisor';
import * as agentDb from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { createMessagingRuntimeHooks } from './runtime-hooks';

const restores: Array<() => void> = [];

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

function stubConfirmation(status: agentDb.AgentConfirmationRecord['status']): void {
  const spy = spyOn(agentDb, 'getAgentConfirmationById').mockReturnValue({
    id: 'c-1',
    status,
  } as agentDb.AgentConfirmationRecord);
  restores.push(() => spy.mockRestore());
}

describe('messaging hooks and the lazy agent supervisor', () => {
  test('unknown confirmation answers notFound without loading the agent runtime', async () => {
    resetAgentRuntimeLoaderForTests();
    const hooks = createMessagingRuntimeHooks();
    expect(await hooks.decideConfirmation?.('missing-confirmation', true)).toEqual({
      ok: false,
      code: 'notFound',
    });
    expect(peekAgentRuntime()).toBeUndefined();
  });

  test('already decided confirmation answers without loading the agent runtime', async () => {
    resetAgentRuntimeLoaderForTests();
    stubConfirmation('approved');
    const hooks = createMessagingRuntimeHooks();
    expect(await hooks.decideConfirmation?.('c-1', false)).toEqual({
      ok: false,
      code: 'alreadyDecided',
    });
    expect(peekAgentRuntime()).toBeUndefined();
  });

  test('pending confirmation loads the supervisor and uses resolveConfirmation', async () => {
    resetAgentRuntimeLoaderForTests();
    stubConfirmation('pending');
    const calls: Array<[string, boolean, string | undefined]> = [];
    const resolveSpy = spyOn(agentSupervisor, 'resolveConfirmation').mockImplementation(
      (id: string, approved: boolean, reason?: string) => {
        calls.push([id, approved, reason]);
        return {} as agentDb.AgentConfirmationRecord;
      }
    );
    restores.push(() => resolveSpy.mockRestore());
    const hooks = createMessagingRuntimeHooks();
    expect(await hooks.decideConfirmation?.('c-1', false, 'no')).toEqual({ ok: true });
    expect(calls).toEqual([['c-1', false, 'no']]);
    expect(peekAgentRuntime()?.agentSupervisor).toBe(agentSupervisor);
  });
});
