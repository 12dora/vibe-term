import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { peekAgentRuntime, resetAgentRuntimeLoaderForTests } from '../agent/lazy';
import { getDb as getOrmDb } from '../db/client';
import { createMessagingRuntimeHooks } from './runtime-hooks';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

describe('messaging hooks without a loaded agent supervisor', () => {
  test('decideConfirmation answers from the DB and keeps the agent runtime unloaded', () => {
    resetAgentRuntimeLoaderForTests();
    const hooks = createMessagingRuntimeHooks();
    expect(hooks.decideConfirmation?.('missing-confirmation', true)).toEqual({
      ok: false,
      code: 'notFound',
    });
    expect(peekAgentRuntime()).toBeUndefined();
  });
});
