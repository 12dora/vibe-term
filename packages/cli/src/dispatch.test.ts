import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { UsageError } from './core/errors';
import { Output } from './core/output';
import { dispatch, findCommandToken, helpForArgv, prepareCommand } from './dispatch';

function capture(): { out: Output; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const out = new Output({
    json: false,
    quiet: false,
    color: false,
    stdout: new Writable({
      write(chunk, _enc, cb) {
        stdout += String(chunk);
        cb();
      },
    }),
    stderr: new Writable({
      write(chunk, _enc, cb) {
        stderr += String(chunk);
        cb();
      },
    }),
  });
  return {
    out,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

describe('dispatch table', () => {
  test('prints global help when no command is given', async () => {
    const cap = capture();
    const code = await dispatch([], cap.out, 'GLOBAL');
    expect(code).toBe(0);
    expect(cap.stdout).toBe('GLOBAL\n');
  });

  test('prints global help for `help` with no target', async () => {
    const cap = capture();
    expect(await dispatch(['help'], cap.out, 'GLOBAL')).toBe(0);
    expect(cap.stdout).toBe('GLOBAL\n');
  });

  test('unknown command throws UsageError', async () => {
    const cap = capture();
    await expect(dispatch(['nope'], cap.out, 'GLOBAL')).rejects.toBeInstanceOf(UsageError);
  });

  test('helpForArgv is null for a real command token', () => {
    expect(helpForArgv(['whoami'], 'GLOBAL')).toBeNull();
    expect(helpForArgv(['--json', 'whoami'], 'GLOBAL')).toBeNull();
  });

  test('findCommandToken skips valued global flags', () => {
    expect(findCommandToken(['--entry', 'http://x:1', 'whoami'])).toEqual({
      name: 'whoami',
      index: 2,
    });
  });
});

describe('prepareCommand nodes enroll --password', () => {
  test('bare --password parses as a switch before splitGlobalFlags', () => {
    const prepared = prepareCommand(['nodes', 'enroll', '--password']);
    expect(prepared.command.name).toBe('nodes');
    expect(prepared.commandArgv).toEqual(['enroll', '--password=']);
    expect(prepared.json).toBe(false);
  });

  test('bare --password before --name parses', () => {
    const prepared = prepareCommand(['nodes', 'enroll', '--password', '--name', 'x']);
    expect(prepared.commandArgv).toEqual(['enroll', '--password=', '--name', 'x']);
  });

  test('bare --password after --json parses', () => {
    const prepared = prepareCommand(['nodes', 'enroll', '--json', '--password']);
    expect(prepared.json).toBe(true);
    expect(prepared.commandArgv).toEqual(['enroll', '--password=']);
  });
});
