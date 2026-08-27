import { describe, expect, test } from 'bun:test';
import { reenableDirectAfterUpgrade } from './upgrade';

describe('reenableDirectAfterUpgrade', () => {
  test('calls reenableDirectIfNeeded with installDir', async () => {
    let calledWith: string | undefined;
    await reenableDirectAfterUpgrade('/tmp/tmex-upgrade', {
      reenableDirectIfNeeded: async ({ installDir }) => {
        calledWith = installDir;
        return {
          ok: true,
          skipped: true,
          platformId: '',
          version: '',
          addonPath: '',
        };
      },
    });
    expect(calledWith).toBe('/tmp/tmex-upgrade');
  });

  test('does not throw when reenable reports failure', async () => {
    const logs: string[] = [];
    await reenableDirectAfterUpgrade('/tmp/tmex-upgrade-fail', {
      reenableDirectIfNeeded: async () => ({ ok: false, reason: 'integrity mismatch' }),
      log: (message) => logs.push(message),
    });
    expect(logs.join('\n')).toContain('integrity mismatch');
  });

  test('swallows thrown errors from reenableDirectIfNeeded', async () => {
    await reenableDirectAfterUpgrade('/tmp/tmex-upgrade-throw', {
      reenableDirectIfNeeded: async () => {
        throw new Error('no network');
      },
      log: () => undefined,
    });
  });
});
