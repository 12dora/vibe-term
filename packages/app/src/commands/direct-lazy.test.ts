import { describe, expect, test } from 'bun:test';
import * as direct from './direct';
import { loadDirectCommands } from './direct-lazy';

describe('direct-lazy', () => {
  test('loads the same direct command module on demand', async () => {
    const loaded = await loadDirectCommands();
    expect(loaded.enableDirect).toBe(direct.enableDirect);
    expect(loaded.disableDirect).toBe(direct.disableDirect);
    expect(loaded.DIRECT_ENABLE_TIMEOUT_MS).toBe(60_000);
  });
});
