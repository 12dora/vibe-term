import { describe, expect, test } from 'bun:test';
import { parseArgs } from './args';
import { confirmDestructiveReset } from './hub-user-passwd';

describe('destructive reset confirmation', () => {
  test('non-TTY refuses without --yes and prints warning first', async () => {
    const logs: string[] = [];
    await expect(
      confirmDestructiveReset(
        parseArgs([]),
        { isTTY: false, log: (line) => logs.push(line) },
        'warning'
      )
    ).rejects.toThrow();
    expect(logs).toEqual(['warning']);
  });
  test('--yes permits non-TTY and prints warning', async () => {
    const logs: string[] = [];
    await confirmDestructiveReset(
      parseArgs(['--yes']),
      { isTTY: false, log: (line) => logs.push(line) },
      'warning'
    );
    expect(logs).toEqual(['warning']);
  });
  test('TTY still requires typed yes when --yes is present', async () => {
    await expect(
      confirmDestructiveReset(parseArgs(['--yes']), {
        isTTY: true,
        readConfirmation: async () => 'y',
        log() {},
      })
    ).rejects.toThrow();
    await confirmDestructiveReset(parseArgs(['--yes']), {
      isTTY: true,
      readConfirmation: async () => 'yes',
      log() {},
    });
  });
  test('TTY requires typed yes', async () => {
    for (const answer of ['', 'y', 'YES', 'no']) {
      await expect(
        confirmDestructiveReset(parseArgs([]), {
          isTTY: true,
          readConfirmation: async () => answer,
          log() {},
        })
      ).rejects.toThrow();
    }
    await confirmDestructiveReset(parseArgs([]), {
      isTTY: true,
      readConfirmation: async () => 'yes',
      log() {},
    });
  });
});
