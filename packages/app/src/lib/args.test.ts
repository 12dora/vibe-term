import { describe, expect, test } from 'bun:test';
import { cliHelpText } from '../cli/help';
import { assertKnownFlags, parseArgs, resolveNestedCommand } from './args';

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

  test('resolves hub standby/promote/demote/list', () => {
    const standby = parseArgs([
      'hub',
      'standby',
      '--public-url',
      'https://standby.example',
      '--priority',
      '50',
      '--insecure-local',
      '--no-restart',
    ]);
    expect(resolveNestedCommand(standby).name).toBe('hub.standby');
    expect(standby.flags['public-url']).toBe('https://standby.example');
    expect(standby.flags.priority).toBe('50');
    expect(standby.flags['insecure-local']).toBe(true);
    expect(standby.flags['no-restart']).toBe(true);

    const promote = parseArgs(['hub', 'promote', '--yes', '--no-restart']);
    expect(resolveNestedCommand(promote).name).toBe('hub.promote');
    expect(promote.flags.yes).toBe(true);
    expect(promote.flags['no-restart']).toBe(true);

    expect(resolveNestedCommand(parseArgs(['hub', 'demote', '--no-restart'])).name).toBe(
      'hub.demote'
    );
    expect(resolveNestedCommand(parseArgs(['hub', 'list'])).name).toBe('hub.list');
  });

  test('resolves hub allow/disallow node ids', () => {
    const allow = parseArgs(['hub', 'allow', 'aa'.repeat(16), 'bb'.repeat(16), '--no-restart']);
    const allowNested = resolveNestedCommand(allow);
    expect(allowNested.name).toBe('hub.allow');
    expect(allowNested.rest).toEqual(['aa'.repeat(16), 'bb'.repeat(16)]);
    expect(allow.flags['no-restart']).toBe(true);

    const disallow = parseArgs(['hub', 'disallow', 'cc'.repeat(16), '--no-restart']);
    const disallowNested = resolveNestedCommand(disallow);
    expect(disallowNested.name).toBe('hub.disallow');
    expect(disallowNested.rest).toEqual(['cc'.repeat(16)]);
    expect(disallow.flags['no-restart']).toBe(true);
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

  test('treats --help and -h as help flags even after a command', () => {
    const parsed = parseArgs(['upgrade', '--help']);
    expect(parsed.command).toBe('upgrade');
    expect(parsed.flags.help).toBe(true);
    const short = parseArgs(['upgrade', '-h']);
    expect(short.flags.help).toBe(true);
  });
});

describe('assertKnownFlags', () => {
  test('rejects unknown upgrade flags instead of ignoring them', () => {
    expect(() => assertKnownFlags(parseArgs(['upgrade', '--not-a-real-flag']))).toThrow(
      /Unknown flag|未知参数/
    );
  });

  test('accepts hub standby/promote flags and rejects unknown ones', () => {
    expect(() =>
      assertKnownFlags(
        parseArgs([
          'hub',
          'standby',
          '--public-url',
          'https://standby.example',
          '--priority',
          '200',
          '--insecure-local',
          '--no-restart',
          '--install-dir',
          '/tmp',
        ])
      )
    ).not.toThrow();
    expect(() =>
      assertKnownFlags(parseArgs(['hub', 'promote', '--yes', '--no-restart']))
    ).not.toThrow();
    expect(() => assertKnownFlags(parseArgs(['hub', 'demote', '--no-restart']))).not.toThrow();
    expect(() =>
      assertKnownFlags(parseArgs(['hub', 'list', '--install-dir', '/tmp']))
    ).not.toThrow();
    expect(() =>
      assertKnownFlags(
        parseArgs(['hub', 'allow', 'aa'.repeat(16), '--no-restart', '--install-dir', '/tmp'])
      )
    ).not.toThrow();
    expect(() =>
      assertKnownFlags(parseArgs(['hub', 'disallow', 'aa'.repeat(16), '--no-restart']))
    ).not.toThrow();
    expect(() => assertKnownFlags(parseArgs(['hub', 'standby', '--not-a-real-flag']))).toThrow(
      /Unknown flag|未知参数/
    );
    expect(() => assertKnownFlags(parseArgs(['hub', 'allow', '--not-a-real-flag']))).toThrow(
      /Unknown flag|未知参数/
    );
  });

  test('accepts hub user passwd --full-reset', () => {
    const parsed = parseArgs(['hub', 'user', 'passwd', 'bob', '--full-reset']);
    expect(parsed.flags['full-reset']).toBe(true);
    expect(() => assertKnownFlags(parsed)).not.toThrow();
  });

  test('accepts documented upgrade flags', () => {
    expect(() =>
      assertKnownFlags(
        parseArgs(['upgrade', '--apply-current-package', '--no-service', '--install-dir', '/tmp'])
      )
    ).not.toThrow();
  });

  test('accepts upgrade --txn, --allow-unverified and --no-service together', () => {
    expect(() =>
      assertKnownFlags(
        parseArgs([
          'upgrade',
          '--apply-current-package',
          '--no-service',
          '--txn',
          'abc',
          '--allow-unverified',
          '--install-dir',
          '/tmp',
        ])
      )
    ).not.toThrow();
  });
});

describe('cli help', () => {
  test('lists nested hub commands and existing init/doctor', () => {
    const help = cliHelpText('en');
    expect(help).toContain('tmex init');
    expect(help).toContain('tmex doctor');
    expect(help).toContain('tmex hub user add <username>');
    expect(help).toContain('tmex hub user passwd <username> [--full-reset]');
    expect(help).toContain(
      'also remove all passkeys and two-step verification and sign out everywhere'
    );
    expect(cliHelpText('zh-CN')).toContain('同时移除所有通行密钥、两步验证并注销全部会话');
    expect(help).toContain('tmex hub join');
    expect(help).toContain('tmex hub standby --public-url');
    expect(help).toContain('tmex hub promote');
    expect(help).toContain('tmex hub demote');
    expect(help).toContain('tmex hub list');
    expect(help).toContain('tmex hub allow');
    expect(help).toContain('tmex hub disallow');
    expect(help).toContain('--no-restart');
    expect(help).toContain('tmex mesh reset-root');
    expect(help).toContain('tmex enroll');
    expect(help).toContain('TMEX_PASSWORD');
  });
});
