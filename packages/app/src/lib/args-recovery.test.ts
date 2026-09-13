import { describe, expect, test } from 'bun:test';
import { cliHelpText } from '../cli/help';
import { assertKnownFlags, parseArgs, resolveNestedCommand } from './args';
import { AUTH_COMMANDS } from './auth-spawn';

const commands = [
  {
    command: 'hub trust refresh',
    rest: ['https://hub.example'],
    flags: ['--fingerprint', 'a'.repeat(64)],
  },
  { command: 'hub ca fingerprint', rest: [], flags: [] },
  { command: 'hub ca rotate', rest: [], flags: ['--yes'] },
  { command: 'hub urls list', rest: [], flags: [] },
  { command: 'hub urls add', rest: ['https://hub.example'], flags: [] },
  { command: 'hub urls remove', rest: ['https://hub.example'], flags: [] },
  { command: 'mesh reset-identity', rest: [], flags: ['--reset-tls', '--yes'] },
  { command: 'tls reset', rest: [], flags: ['--yes'] },
  { command: 'mesh keylog status', rest: [], flags: [] },
  { command: 'mesh reset-root', rest: [], flags: ['--yes'] },
  { command: 'hub user passwd', rest: ['alice'], flags: ['--full-reset', '--yes'] },
  { command: 'relay pack upload', rest: [], flags: [] },
];

describe('recovery CLI wiring', () => {
  for (const { command, rest, flags } of commands) {
    test(`${command} resolves, accepts flags, uses Bun auth and appears in both help languages`, () => {
      const parsed = parseArgs([...command.split(' '), ...rest, ...flags]);
      const nested = resolveNestedCommand(parsed);
      expect<string>(nested.name).toBe(command.replaceAll(' ', '.'));
      expect(nested.rest).toEqual(rest);
      expect(() => assertKnownFlags(parsed)).not.toThrow();
      expect(AUTH_COMMANDS.has(nested.name)).toBe(true);
      for (const lang of ['en', 'zh-CN'] as const) {
        expect(cliHelpText(lang)).toContain(`vibeterm ${command}`);
      }
    });
  }

  test('every relay subcommand is routed to the auth entry', () => {
    for (const sub of [
      'status',
      'tenants',
      'metrics',
      'passwd',
      'kick',
      'remove',
      'quota',
      'limits',
      'label',
    ] as const) {
      const nested = resolveNestedCommand(parseArgs(['relay', sub]));
      expect(nested.name).toBe(`relay.${sub}`);
      expect(AUTH_COMMANDS.has(nested.name)).toBe(true);
    }
  });

  test('relay-admin aliases preserve force and tenant arguments', () => {
    for (const [command, rest] of [
      ['passwd', []],
      ['kick', ['tenant']],
    ] as const) {
      const parsed = parseArgs(['relay-admin', command, ...rest, '--force']);
      expect(resolveNestedCommand(parsed)).toMatchObject({ name: `relay.${command}`, rest });
      expect(() => assertKnownFlags(parsed)).not.toThrow();
      expect(AUTH_COMMANDS.has(`relay.${command}`)).toBe(true);
      for (const lang of ['en', 'zh-CN'] as const) {
        expect(cliHelpText(lang)).toContain(`vibeterm relay-admin ${command}`);
      }
    }
  });

  test('unknown nested actions and unrelated flags remain rejected', () => {
    for (const command of [
      'hub trust',
      'hub trust reset',
      'hub ca delete',
      'hub urls clear',
      'mesh keylog reset',
    ]) {
      expect(resolveNestedCommand(parseArgs(command.split(' '))).name).toBe('unknown');
    }
    for (const command of ['hub urls list', 'hub ca fingerprint', 'mesh keylog status']) {
      expect(() => assertKnownFlags(parseArgs([...command.split(' '), '--yes']))).toThrow();
    }
  });
});
