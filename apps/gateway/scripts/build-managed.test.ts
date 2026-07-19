import { describe, expect, test } from 'bun:test';

import { MANAGED_NODE_ENV_DEFINE, createManagedCompileEnvironment } from './build-managed';

describe('managed gateway compile environment', () => {
  test('forces production even when the caller inherited development', () => {
    const env = createManagedCompileEnvironment({
      NODE_ENV: 'development',
      TMEX_MANAGED_FORCE_CROSS: '1',
    });

    expect(env.NODE_ENV).toBe('production');
    expect(env.TMEX_MANAGED_FORCE_CROSS).toBe('1');
    expect(MANAGED_NODE_ENV_DEFINE).toBe('process.env.NODE_ENV="production"');
  });
});
