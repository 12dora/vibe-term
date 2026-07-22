import { describe, expect, test } from 'bun:test';

import {
  TMEX_SERVER_EPOCH_OPTION,
  type TmuxCommandResult,
  decodeServerEpoch,
  ensureStableServerEpoch,
} from './server-epoch';

const FIRST = '00112233445566778899aabbccddeeff';
const SECOND = 'ffeeddccbbaa99887766554433221100';

function ok(stdout = ''): TmuxCommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

describe('stable tmux server epoch', () => {
  test('decodes the fixed lower-case bytes16 representation', () => {
    expect(Array.from(decodeServerEpoch(FIRST))).toEqual([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
      0xff,
    ]);
    expect(() => decodeServerEpoch('0011')).toThrow();
    expect(() => decodeServerEpoch(FIRST.toUpperCase())).toThrow();
  });

  test('atomically creates once and re-reads the winner', async () => {
    let stored = '';
    const commands: string[][] = [];
    const runner = async (argv: string[]): Promise<TmuxCommandResult> => {
      commands.push(argv);
      if (argv[0] === 'show-options') return ok(stored);
      if (!stored) stored = SECOND;
      return ok();
    };

    expect(Array.from(await ensureStableServerEpoch(runner, FIRST))).toEqual(
      Array.from(decodeServerEpoch(SECOND))
    );
    expect(commands).toEqual([
      ['show-options', '-gqv', TMEX_SERVER_EPOCH_OPTION],
      ['set-option', '-gq', '-o', TMEX_SERVER_EPOCH_OPTION, FIRST],
      ['show-options', '-gqv', TMEX_SERVER_EPOCH_OPTION],
    ]);
  });

  test('reuses an existing value without writing and rejects malformed state', async () => {
    let writes = 0;
    const existing = await ensureStableServerEpoch(async (argv) => {
      if (argv[0] === 'set-option') writes += 1;
      return ok(FIRST);
    }, SECOND);
    expect(existing).toEqual(decodeServerEpoch(FIRST));
    expect(writes).toBe(0);

    await expect(ensureStableServerEpoch(async () => ok('not-an-epoch'), SECOND)).rejects.toThrow(
      `invalid ${TMEX_SERVER_EPOCH_OPTION} value`
    );
  });
});
