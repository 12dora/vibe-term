import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenSshTarget } from '../../files/ssh-target';
import { execIo } from '../io';
import { ExecChannelError } from './errors';
import { spawnExecProcess } from './process';
import { collectAll, openSpec, testDevice } from './process-test-util';
import { ptySupported } from './pty';

const ptyTest = ptySupported() ? test : test.skip;
const originalResolve = execIo.resolveSsh;
let dir = '';
let cleanups = 0;
const saved = { ...process.env };

function fakeTarget(overrides: Partial<OpenSshTarget> = {}): OpenSshTarget {
  const script = join(dir, 'fake-ssh.sh');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@"',
      'printf "SECRET=%s\\n" "${VIBETERM_MASTER_KEY-unset}"',
      'printf "EXTRA=%s\\n" "${FROM_TARGET-unset}"',
      'printf "TERM=%s\\n" "$TERM"',
      '',
    ].join('\n')
  );
  chmodSync(script, 0o755);
  return {
    dest: 'dev@host.example',
    sshArgs: [script, '-p', '22'],
    env: { FROM_TARGET: 'yes' },
    cleanup: () => {
      cleanups += 1;
    },
    interactive: false,
    ...overrides,
  };
}

function useTarget(target: OpenSshTarget): void {
  execIo.resolveSsh = (async () => ({ ok: true, target })) as typeof execIo.resolveSsh;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vt-ssh-proc-'));
  cleanups = 0;
});

afterEach(() => {
  execIo.resolveSsh = originalResolve;
  rmSync(dir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

describe('ssh exec process', () => {
  test('spawns ssh with the built argv, a scrubbed env, and cleans up on exit', async () => {
    process.env.VIBETERM_MASTER_KEY = 'secret';
    useTarget(fakeTarget());
    const proc = await spawnExecProcess(
      testDevice('ssh'),
      openSpec({ command: { kind: 'argv', argv: ['echo', 'hi'] } })
    );
    const { stdout, exit } = await collectAll(proc);
    expect(exit.code).toBe(0);
    const lines = stdout.split('\n');
    expect(lines.slice(0, 6)).toEqual([
      '-p',
      '22',
      '-T',
      'dev@host.example',
      '--',
      "exec 'echo' 'hi'",
    ]);
    expect(lines).toContain('SECRET=unset');
    expect(lines).toContain('EXTRA=yes');
    await Bun.sleep(20);
    expect(cleanups).toBe(1);
  });

  ptyTest('pty mode runs ssh under a local terminal with -tt and TERM', async () => {
    useTarget(fakeTarget());
    const proc = await spawnExecProcess(
      testDevice('ssh'),
      openSpec({
        command: { kind: 'login' },
        pty: { cols: 90, rows: 30, term: 'vt100' },
        stdin: true,
      })
    );
    expect(proc.pty).toBe(true);
    const { stdout } = await collectAll(proc);
    expect(stdout).toContain('-tt');
    expect(stdout).toContain('TERM=vt100');
  });

  test('password devices are unsupported and release their temp files', async () => {
    useTarget(fakeTarget({ interactive: true }));
    const err = await spawnExecProcess(testDevice('ssh'), openSpec()).catch((e) => e);
    expect(err).toBeInstanceOf(ExecChannelError);
    expect(err.code).toBe('exec_unsupported_device');
    expect(cleanups).toBe(1);
  });

  test('resolve failures map to the matching error codes', async () => {
    execIo.resolveSsh = (async () => ({
      ok: false,
      code: 'auth_unsupported',
      message: 'no auth',
    })) as typeof execIo.resolveSsh;
    const unsupported = await spawnExecProcess(testDevice('ssh'), openSpec()).catch((e) => e);
    expect(unsupported.code).toBe('exec_unsupported_device');
    execIo.resolveSsh = (async () => ({
      ok: false,
      code: 'connection_failed',
      message: 'no host',
    })) as typeof execIo.resolveSsh;
    const failed = await spawnExecProcess(testDevice('ssh'), openSpec()).catch((e) => e);
    expect(failed.code).toBe('exec_spawn_failed');
  });

  test('a failed spawn still runs cleanup', async () => {
    useTarget(fakeTarget({ sshArgs: ['/nonexistent/ssh-xyz'] }));
    const err = await spawnExecProcess(testDevice('ssh'), openSpec()).catch((e) => e);
    expect(err.code).toBe('exec_spawn_failed');
    expect(cleanups).toBe(1);
  });
});
