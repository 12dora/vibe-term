import { describe, expect, test } from 'bun:test';
import { cliHelpText } from '../cli/help';
import {
  STUN_SERVERS_FLAG_HELP,
  assertKnownFlags,
  parseArgs,
  requireFlagValue,
  resolveNestedCommand,
} from './args';

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
  test('resolves user add <username>', () => {
    const nested = resolveNestedCommand(parseArgs(['user', 'add', 'alice']));
    expect(nested.name).toBe('user.add');
    expect(nested.rest).toEqual(['alice']);
  });

  test('resolves user passwd/totp', () => {
    expect(resolveNestedCommand(parseArgs(['user', 'passwd', 'bob'])).name).toBe('user.passwd');
    expect(resolveNestedCommand(parseArgs(['user', 'totp', 'bob'])).name).toBe('user.totp');
  });

  test('rejects the deleted hub and enroll groups', () => {
    expect(resolveNestedCommand(parseArgs(['hub', 'user', 'add', 'alice'])).name).toBe('unknown');
    expect(resolveNestedCommand(parseArgs(['hub', 'join', 'https://example'])).name).toBe(
      'unknown'
    );
    expect(resolveNestedCommand(parseArgs(['enroll', '--ttl', '10m'])).name).toBe('unknown');
    expect(resolveNestedCommand(parseArgs(['user', 'reset'])).name).toBe('unknown');
  });

  test('parses relay join --no-restart as a boolean flag', () => {
    const join = parseArgs([
      'relay',
      'join',
      'https://relay.example',
      '--tenant',
      't1',
      '--no-restart',
    ]);
    expect(join.flags['no-restart']).toBe(true);
    expect(resolveNestedCommand(join).name).toBe('relay.join');
  });

  test('resolves mesh reset-root and direct', () => {
    expect(resolveNestedCommand(parseArgs(['mesh', 'reset-root'])).name).toBe('mesh.reset-root');
    const direct = resolveNestedCommand(parseArgs(['direct', 'enable']));
    expect(direct.name).toBe('direct');
    expect(direct.rest).toEqual(['enable']);
  });

  test('resolves init --role node', () => {
    const parsed = parseArgs(['init', '--role', 'node']);
    expect(resolveNestedCommand(parsed).name).toBe('init');
    expect(parsed.flags.role).toBe('node');
  });

  test('parses init --stun-servers and documents the built-in default', () => {
    const parsed = parseArgs(['init', '--stun-servers', 'none']);
    expect(parsed.flags['stun-servers']).toBe('none');
    expect(() => assertKnownFlags(parsed)).not.toThrow();
    expect(STUN_SERVERS_FLAG_HELP).toMatch(/built-in list shipped with each release/i);
    expect(STUN_SERVERS_FLAG_HELP).toMatch(/none.*disables/i);
    expect(cliHelpText('en')).toContain('--stun-servers <list>');
    expect(cliHelpText('en')).toContain(STUN_SERVERS_FLAG_HELP);
    expect(cliHelpText('zh-CN')).toContain('--stun-servers <list>');
    expect(cliHelpText('zh-CN')).toMatch(/默认.*内置/);
    expect(cliHelpText('zh-CN')).toContain('none');
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

  test('accepts user passwd --full-reset', () => {
    const parsed = parseArgs(['user', 'passwd', 'bob', '--full-reset']);
    expect(parsed.flags['full-reset']).toBe(true);
    expect(() => assertKnownFlags(parsed)).not.toThrow();
  });

  test('rejects unknown user flags', () => {
    expect(() => assertKnownFlags(parseArgs(['user', 'add', '--not-a-real-flag']))).toThrow(
      /Unknown flag|未知参数/
    );
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
  test('lists user/relay commands and existing init/doctor', () => {
    const help = cliHelpText('en');
    expect(help).toContain('vibeterm init');
    expect(help).toContain('vibeterm doctor');
    expect(help).toContain('vibeterm user add <username>');
    expect(help).toContain('vibeterm user passwd <username> [--full-reset]');
    expect(help).not.toContain('vibeterm hub ');
    expect(help).not.toContain('vibeterm enroll');
    expect(help).not.toContain('vibeterm user reset');
    expect(help).toContain(
      'also remove all passkeys and two-step verification and sign out everywhere'
    );
    expect(cliHelpText('zh-CN')).toContain('同时移除所有通行密钥、两步验证并注销全部会话');
    expect(help).toContain('vibeterm relay join');
    expect(help).toContain('--token <r3.…>');
    expect(help).toContain('--no-restart');
    expect(help).toContain('vibeterm mesh reset-root');
    expect(help).toContain('VIBETERM_PASSWORD');
  });
});

describe('requireFlagValue', () => {
  test('没给的旗标返回 undefined，给了值的返回原文', () => {
    const parsed = parseArgs(['relay', 'limits', '--max-tenants', '4']);
    expect(requireFlagValue(parsed.flags, 'max-tenants')).toBe('4');
    expect(requireFlagValue(parsed.flags, 'fair-share')).toBeUndefined();
  });

  test('光秃秃的旗标与空值都报用法错，不被当成没给', () => {
    const bare = parseArgs(['relay', 'limits', '--max-tenants']);
    expect(bare.flags['max-tenants']).toBe(true);
    expect(() => requireFlagValue(bare.flags, 'max-tenants')).toThrow('--max-tenants');
    const chained = parseArgs(['relay', 'limits', '--max-tenants', '--fair-share', 'off']);
    expect(() => requireFlagValue(chained.flags, 'max-tenants')).toThrow('--max-tenants');
    expect(requireFlagValue(chained.flags, 'fair-share')).toBe('off');
    const empty = parseArgs(['relay', 'limits', '--max-tenants=']);
    expect(() => requireFlagValue(empty.flags, 'max-tenants')).toThrow('--max-tenants');
    const blank = parseArgs(['relay', 'limits', '--max-tenants=   ']);
    expect(() => requireFlagValue(blank.flags, 'max-tenants')).toThrow('--max-tenants');
  });
});

describe('init shim override', () => {
  test.each(['--replace-shim', '--replace-shim=true', '--replace-shim=false'])(
    'accepts %s and documents the explicit takeover flag',
    (flag) => {
      expect(() => assertKnownFlags(parseArgs(['init', flag]))).not.toThrow();
      for (const lang of ['en', 'zh-CN'] as const) {
        expect(cliHelpText(lang)).toContain('[--replace-shim]');
      }
    }
  );
});
