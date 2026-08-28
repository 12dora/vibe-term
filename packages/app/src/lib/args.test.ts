import { describe, expect, test } from 'bun:test';
import { cliHelpText } from '../cli/help';
import { parseArgs, resolveNestedCommand } from './args';

describe('parseArgs', () => {
  test('parses command, flags and positionals', () => {
    const parsed = parseArgs(['init', '--host', '0.0.0.0', '--port=9883', 'extra']);

    expect(parsed.command).toBe('init');
    expect(parsed.positionals).toEqual(['extra']);
    expect(parsed.flags.host).toBe('0.0.0.0');
    expect(parsed.flags.port).toBe('9883');
  });

  test('parses boolean flags', () => {
    const parsed = parseArgs(['doctor', '--json', '--no-interactive']);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags['no-interactive']).toBe(true);
  });

  test('allows global flags before command', () => {
    const parsed = parseArgs(['--lang', 'zh-CN', 'doctor', '--json']);
    expect(parsed.command).toBe('doctor');
    expect(parsed.flags.lang).toBe('zh-CN');
    expect(parsed.flags.json).toBe(true);
  });
});

describe('resolveNestedCommand', () => {
  test('resolves hub user add <username>', () => {
    const nested = resolveNestedCommand(parseArgs(['hub', 'user', 'add', 'alice']));
    expect(nested.name).toBe('hub.user.add');
    expect(nested.rest).toEqual(['alice']);
  });

  test('resolves hub user passwd/totp/reset', () => {
    expect(resolveNestedCommand(parseArgs(['hub', 'user', 'passwd', 'bob'])).name).toBe(
      'hub.user.passwd'
    );
    expect(resolveNestedCommand(parseArgs(['hub', 'user', 'totp', 'bob'])).name).toBe(
      'hub.user.totp'
    );
    expect(resolveNestedCommand(parseArgs(['hub', 'user', 'reset'])).name).toBe('hub.user.reset');
  });

  test('resolves hub join with token flag', () => {
    const parsed = parseArgs([
      'hub',
      'join',
      'https://hub.example',
      '--token',
      'abc',
      '--name',
      'n1',
    ]);
    const nested = resolveNestedCommand(parsed);
    expect(nested.name).toBe('hub.join');
    expect(nested.rest).toEqual(['https://hub.example']);
    expect(parsed.flags.token).toBe('abc');
    expect(parsed.flags.name).toBe('n1');
  });

  test('parses hub join/leave --no-restart as a boolean flag', () => {
    const join = parseArgs([
      'hub',
      'join',
      'https://hub.example',
      '--token',
      'abc',
      '--no-restart',
    ]);
    expect(join.flags['no-restart']).toBe(true);
    const leave = parseArgs(['hub', 'leave', '--no-restart', '--install-dir', '/tmp/tmex']);
    expect(leave.flags['no-restart']).toBe(true);
    expect(leave.flags['install-dir']).toBe('/tmp/tmex');
  });

  test('resolves hub leave, mesh reset-root, enroll, direct', () => {
    expect(resolveNestedCommand(parseArgs(['hub', 'leave'])).name).toBe('hub.leave');
    expect(resolveNestedCommand(parseArgs(['mesh', 'reset-root'])).name).toBe('mesh.reset-root');
    expect(resolveNestedCommand(parseArgs(['enroll', '--ttl', '10m'])).name).toBe('enroll');
    const direct = resolveNestedCommand(parseArgs(['direct', 'enable']));
    expect(direct.name).toBe('direct');
    expect(direct.rest).toEqual(['enable']);
  });

  test('resolves init --role hub,node', () => {
    const parsed = parseArgs(['init', '--role', 'hub,node']);
    expect(resolveNestedCommand(parsed).name).toBe('init');
    expect(parsed.flags.role).toBe('hub,node');
  });

  test('keeps existing commands', () => {
    expect(resolveNestedCommand(parseArgs(['doctor', '--json'])).name).toBe('doctor');
    expect(resolveNestedCommand(parseArgs(['upgrade'])).name).toBe('upgrade');
    expect(resolveNestedCommand(parseArgs(['uninstall'])).name).toBe('uninstall');
    expect(resolveNestedCommand(parseArgs(['--help'])).name).toBe('help');
  });
});

describe('cli help', () => {
  test('lists nested hub commands and existing init/doctor', () => {
    const help = cliHelpText('en');
    expect(help).toContain('tmex init');
    expect(help).toContain('tmex doctor');
    expect(help).toContain('tmex hub user add <username>');
    expect(help).toContain('tmex hub join');
    expect(help).toContain('--no-restart');
    expect(help).toContain('tmex mesh reset-root');
    expect(help).toContain('tmex enroll');
    expect(help).toContain('TMEX_PASSWORD');
  });
});
