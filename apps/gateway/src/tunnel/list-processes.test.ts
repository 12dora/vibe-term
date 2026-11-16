import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PS_LIST_COMMANDS,
  defaultListProcesses,
  parsePsOutput,
  psTableLooksValid,
} from './list-processes';

const BUSYBOX_TABLE = `  PID USER       VSZ STAT COMMAND
    1 root      1548 S    /sbin/init
  42 alicia    9999 S    cloudflared
`;

const VALID_TABLE = '    7 /usr/bin/cloudflared tunnel run --token-file /tmp/token\n';

describe('process listing fallbacks', () => {
  test('ps flag order matches the window-memory sampler chain', () => {
    expect(PS_LIST_COMMANDS.map((args) => args.slice(1).join(' '))).toEqual([
      '-Ao pid=,command=',
      '-eo pid=,command=',
      'ax -o pid=,command=',
      '-o pid=,command=',
    ]);
  });

  test('BusyBox default tables are invalid even though pid lines parse', () => {
    expect(psTableLooksValid(BUSYBOX_TABLE)).toBe(false);
    expect(parsePsOutput(BUSYBOX_TABLE)[0]?.pid).toBe(1);
    expect(psTableLooksValid(VALID_TABLE)).toBe(true);
    expect(psTableLooksValid('  PID COMMAND\n    7 /usr/bin/cloudflared tunnel run\n')).toBe(true);
    expect(psTableLooksValid('')).toBe(false);
  });

  test('skips BusyBox-style tables and uses the next ps candidate', async () => {
    const seen: string[] = [];
    const procs = await defaultListProcesses({
      platform: 'darwin',
      spawnPs: async (args) => {
        seen.push(args.join(' '));
        if (args[1] === '-o') return VALID_TABLE;
        return BUSYBOX_TABLE;
      },
    });
    expect(seen).toEqual([
      'ps -Ao pid=,command=',
      'ps -eo pid=,command=',
      'ps ax -o pid=,command=',
      'ps -o pid=,command=',
    ]);
    expect(procs).toEqual([
      { pid: 7, command: '/usr/bin/cloudflared tunnel run --token-file /tmp/token' },
    ]);
  });

  test('Linux scans /proc cmdline when every ps table is unusable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vt-ps-proc-'));
    try {
      mkdirSync(join(dir, '7'));
      mkdirSync(join(dir, '8'));
      writeFileSync(join(dir, '7', 'cmdline'), 'cloudflared\0tunnel\0run\0');
      writeFileSync(join(dir, '8', 'cmdline'), '');
      mkdirSync(join(dir, 'self'));
      const procs = await defaultListProcesses({
        platform: 'linux',
        procRoot: dir,
        spawnPs: async () => BUSYBOX_TABLE,
      });
      expect(procs).toEqual([{ pid: 7, command: 'cloudflared tunnel run' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('non-Linux hosts do not scan /proc after unusable ps output', async () => {
    const procs = await defaultListProcesses({
      platform: 'darwin',
      procRoot: '/no-such-proc',
      spawnPs: async () => BUSYBOX_TABLE,
    });
    expect(procs).toEqual([]);
  });
});

describe('parsePsOutput', () => {
  test('keeps pid and the remainder of the command line', () => {
    expect(
      parsePsOutput(
        '42 /opt/homebrew/bin/cloudflared tunnel --logfile /tmp/cf.log run --token-file /tmp/token\n'
      )
    ).toEqual([
      {
        pid: 42,
        command:
          '/opt/homebrew/bin/cloudflared tunnel --logfile /tmp/cf.log run --token-file /tmp/token',
      },
    ]);
  });
});
