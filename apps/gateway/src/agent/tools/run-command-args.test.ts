import { describe, expect, test } from 'bun:test';
import {
  compileOptionalRegex,
  resolvePromptRegex,
  resolveRunCommandArgs,
  shouldUsePosix,
} from './run-command-args';

describe('resolveRunCommandArgs', () => {
  test('缺省 mode=auto、timeout=15s，bash 走 posix', () => {
    const args = resolveRunCommandArgs({ command: 'ls' });
    expect(args.command).toBe('ls');
    expect(args.mode).toBe('auto');
    expect(args.timeoutMs).toBe(15_000);
    expect(args.usePosix).toBe(true);
    expect(args.expectPattern).toBeUndefined();
    expect(args.promptPattern).toBeUndefined();
  });

  test('显式 timeout/mode/expect/prompt/paging 原样保留', () => {
    const args = resolveRunCommandArgs({
      command: 'show run',
      mode: 'cli',
      shell: 'sh',
      timeoutMs: 3000,
      expect: 'Password:',
      prompt: 'R1#',
      disablePagingCommand: 'terminal length 0',
    });
    expect(args.mode).toBe('cli');
    expect(args.shell).toBe('sh');
    expect(args.timeoutMs).toBe(3000);
    expect(args.usePosix).toBe(false);
    expect(args.expectPattern).toBe('Password:');
    expect(args.promptPattern).toBe('R1#');
    expect(args.disablePagingCommand).toBe('terminal length 0');
  });
});

describe('shouldUsePosix', () => {
  test.each([
    ['posix', 'bash', true],
    ['posix', 'powershell', true],
    ['auto', 'bash', true],
    ['auto', 'zsh', true],
    ['auto', 'sh', true],
    ['auto', 'fish', true],
    ['auto', 'powershell', false],
    ['auto', undefined, true],
    ['cli', 'bash', false],
  ] as const)('mode=%s shell=%s → %s', (mode, shell, expected) => {
    expect(shouldUsePosix(mode, shell)).toBe(expected);
  });
});

describe('compileOptionalRegex', () => {
  test('缺省或空模式返回 null', () => {
    expect(compileOptionalRegex(undefined)).toBeNull();
  });

  test('编译提示符正则', () => {
    const re = compileOptionalRegex('Switch#');
    expect(re).toBeInstanceOf(RegExp);
    expect(re?.test('Switch#')).toBe(true);
    expect(re?.test('R1#')).toBe(false);
  });
});

describe('resolvePromptRegex', () => {
  test('params.prompt 优先于屏上提示符', () => {
    const args = resolveRunCommandArgs({ command: 'x', mode: 'cli', prompt: 'R1#' });
    const re = resolvePromptRegex(args, 'Switch#');
    expect(re?.test('R1#')).toBe(true);
    expect(re?.test('Switch#')).toBe(false);
  });

  test('cli 无 prompt 时从屏末行学习', () => {
    const args = resolveRunCommandArgs({ command: 'x', mode: 'cli' });
    const re = resolvePromptRegex(args, 'user@host:~$ ');
    expect(re?.test('user@host:~$')).toBe(true);
  });

  test('cli 空屏学不到提示符', () => {
    const args = resolveRunCommandArgs({ command: 'x', mode: 'cli' });
    expect(resolvePromptRegex(args, '   \n')).toBeNull();
  });

  test('posix 无 prompt 不学习屏内容', () => {
    const args = resolveRunCommandArgs({ command: 'x', mode: 'posix' });
    expect(resolvePromptRegex(args, 'user@host:~$ ')).toBeNull();
  });
});
