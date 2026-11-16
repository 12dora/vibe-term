import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PS_LIST_COMMANDS,
  type SpawnPsResult,
  defaultListProcesses,
  parsePsOutput,
  psTableLooksValid,
} from './list-processes';

const BUSYBOX_TABLE = `  PID USER       VSZ STAT COMMAND
    1 root      1548 S    /sbin/init
  42 alicia    9999 S    cloudflared
`;

const VALID_TABLE = '    7 /usr/bin/cloudflared tunnel run --token-file /tmp/token\n';
const VALID_PROC = {
  pid: 7,
  command: '/usr/bin/cloudflared tunnel run --token-file /tmp/token',
};

const ok = (text: string): SpawnPsResult => ({ text, exitCode: 0 });
const fail = (text = ''): SpawnPsResult => ({ text, exitCode: 1 });

function makeProcRoot(entries: Array<{ pid: string; cmdline: string | null }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vt-ps-proc-'));
  mkdirSync(join(dir, 'self'));
  for (const entry of entries) {
    mkdirSync(join(dir, entry.pid));
    if (entry.cmdline != null) writeFileSync(join(dir, entry.pid, 'cmdline'), entry.cmdline);
  }
  return dir;
}

describe('process listing fallbacks', () => {
  test('ps uses POSIX args columns and full-process flags', () => {
    expect(PS_LIST_COMMANDS.map((args) => args.slice(1).join(' '))).toEqual([
      '-Ao pid=,args=',
      '-eo pid=,args=',
      'ax -o pid=,args=',
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
        if (args[1] === 'ax') return ok(VALID_TABLE);
        return ok(BUSYBOX_TABLE);
      },
    });
    expect(seen).toEqual(['ps -Ao pid=,args=', 'ps -eo pid=,args=', 'ps ax -o pid=,args=']);
    expect(procs).toEqual([VALID_PROC]);
  });

  test('treats non-zero ps exit as empty even when stdout looks valid', async () => {
    const seen: string[] = [];
    const procs = await defaultListProcesses({
      platform: 'darwin',
      spawnPs: async (args) => {
        seen.push(args.join(' '));
        if (args[1] === '-Ao') return fail(VALID_TABLE);
        if (args[1] === '-eo') return ok(VALID_TABLE);
        return fail();
      },
    });
    expect(seen).toEqual(['ps -Ao pid=,args=', 'ps -eo pid=,args=']);
    expect(procs).toEqual([VALID_PROC]);
  });

  test('Linux scans /proc cmdline first and skips ps when non-empty', async () => {
    const dir = makeProcRoot([
      { pid: '7', cmdline: 'cloudflared\0tunnel\0run\0' },
      { pid: '8', cmdline: '' },
    ]);
    try {
      let spawned = 0;
      const procs = await defaultListProcesses({
        platform: 'linux',
        procRoot: dir,
        spawnPs: async () => {
          spawned += 1;
          return ok(VALID_TABLE);
        },
      });
      expect(spawned).toBe(0);
      expect(procs).toEqual([{ pid: 7, command: 'cloudflared tunnel run' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Linux falls back to ps when /proc is unusable', async () => {
    const seen: string[] = [];
    const procs = await defaultListProcesses({
      platform: 'linux',
      procRoot: '/no-such-proc',
      spawnPs: async (args) => {
        seen.push(args.join(' '));
        return ok(VALID_TABLE);
      },
    });
    expect(seen).toEqual(['ps -Ao pid=,args=']);
    expect(procs).toEqual([VALID_PROC]);
  });

  test('Linux falls back to ps when /proc yields no cmdlines', async () => {
    const dir = makeProcRoot([{ pid: '8', cmdline: '' }]);
    try {
      const procs = await defaultListProcesses({
        platform: 'linux',
        procRoot: dir,
        spawnPs: async () => fail(VALID_TABLE),
      });
      expect(procs).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('non-Linux hosts do not scan /proc after unusable ps output', async () => {
    const procs = await defaultListProcesses({
      platform: 'darwin',
      procRoot: '/no-such-proc',
      spawnPs: async () => ok(BUSYBOX_TABLE),
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
