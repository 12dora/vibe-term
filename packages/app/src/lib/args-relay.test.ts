import { describe, expect, test } from 'bun:test';
import { assertKnownFlags, parseArgs, resolveNestedCommand } from './args';
import { AUTH_COMMANDS } from './auth-spawn';
import { buildAppEnvValues, generateRelayAdminToken, relayEnvDefaults } from './install';
import { parseTmexRoleName, parseTmexRoles, validateRoles } from './roles';

function nested(argv: string[]) {
  return resolveNestedCommand(parseArgs(argv));
}

describe('relay command parsing', () => {
  test('every relay subcommand resolves to its own nested name', () => {
    expect(nested(['relay', 'status']).name).toBe('relay.status');
    expect(nested(['relay', 'tenants']).name).toBe('relay.tenants');
    expect(nested(['relay', 'passwd']).name).toBe('relay.passwd');
    expect(nested(['relay', 'kick', 'abc']).name).toBe('relay.kick');
    expect(nested(['relay', 'remove', 'abc']).name).toBe('relay.remove');
    expect(nested(['relay', 'quota', 'default']).name).toBe('relay.quota');
    expect(nested(['relay', 'label', 'abc', 'text']).name).toBe('relay.label');
    expect(nested(['relay', 'enroll', 'https://r.example']).name).toBe('relay.enroll');
    expect(nested(['relay', 'join', 'https://r.example']).name).toBe('relay.join');
    expect(nested(['relay', 'reauth', 'https://r.example']).name).toBe('relay.reauth');
    expect(nested(['relay', 'leave']).name).toBe('relay.leave');
    expect(nested(['relay', 'list']).name).toBe('relay.list');
  });

  test('positionals after the subcommand become rest', () => {
    expect(nested(['relay', 'label', 'abc', 'build', 'box']).rest).toEqual(['abc', 'build', 'box']);
    expect(nested(['relay', 'enroll', 'https://r.example']).rest).toEqual(['https://r.example']);
  });

  test('an unknown relay subcommand is unknown', () => {
    expect(nested(['relay', 'nope']).name).toBe('unknown');
    expect(nested(['relay']).name).toBe('unknown');
  });

  test('hub and mesh parsing is unchanged by the relay group', () => {
    expect(nested(['hub', 'user', 'passwd', 'ivy']).name).toBe('hub.user.passwd');
    expect(nested(['hub', 'user', 'passwd', 'ivy']).rest).toEqual(['ivy']);
    expect(nested(['hub', 'join', 'https://h.example']).rest).toEqual(['https://h.example']);
    expect(nested(['hub', 'leave']).rest).toEqual([]);
    expect(nested(['mesh', 'reset-root']).name).toBe('mesh.reset-root');
    expect(nested(['hub', 'nope']).name).toBe('unknown');
  });
});

describe('relay flag allowlists', () => {
  test('operator flags are accepted', () => {
    expect(() => assertKnownFlags(parseArgs(['relay', 'status', '--json']))).not.toThrow();
    expect(() =>
      assertKnownFlags(parseArgs(['relay', 'passwd', '--clear', '--kick']))
    ).not.toThrow();
    expect(() => assertKnownFlags(parseArgs(['relay', 'remove', 'abc', '--yes']))).not.toThrow();
    expect(() =>
      assertKnownFlags(
        parseArgs([
          'relay',
          'quota',
          'default',
          '--max-nodes',
          '4',
          '--max-streams',
          '8',
          '--bandwidth',
          'unlimited',
        ])
      )
    ).not.toThrow();
    expect(() => assertKnownFlags(parseArgs(['relay', 'quota', 'abc', '--inherit']))).not.toThrow();
  });

  test('tenant flags are accepted', () => {
    expect(() =>
      assertKnownFlags(parseArgs(['relay', 'enroll', 'https://r.example', '--password', 'p']))
    ).not.toThrow();
    expect(() =>
      assertKnownFlags(parseArgs(['relay', 'enroll', 'https://r.example', '--username', 'ivy']))
    ).not.toThrow();
    expect(() =>
      assertKnownFlags(
        parseArgs(['relay', 'join', 'https://r.example', '--tenant', 'abc', '--password', 'p'])
      )
    ).not.toThrow();
    expect(() => assertKnownFlags(parseArgs(['relay', 'list', '--json']))).not.toThrow();
  });

  test('flags do not leak across relay subcommands', () => {
    expect(() => assertKnownFlags(parseArgs(['relay', 'status', '--kick']))).toThrow(
      'Unknown flag: --kick'
    );
    expect(() => assertKnownFlags(parseArgs(['relay', 'leave', '--json']))).toThrow(
      'Unknown flag: --json'
    );
    expect(() =>
      assertKnownFlags(parseArgs(['relay', 'enroll', 'https://r.example', '--inherit']))
    ).toThrow('Unknown flag: --inherit');
  });

  test('init accepts --relay-public-url', () => {
    expect(() =>
      assertKnownFlags(parseArgs(['init', '--role', 'relay', '--relay-public-url', 'https://r']))
    ).not.toThrow();
  });
});

describe('relay commands run on the Bun auth runtime', () => {
  test('all twelve relay commands are auth commands', () => {
    for (const name of [
      'status',
      'tenants',
      'passwd',
      'kick',
      'remove',
      'quota',
      'label',
      'enroll',
      'join',
      'reauth',
      'leave',
      'list',
    ]) {
      expect(AUTH_COMMANDS.has(`relay.${name}`)).toBe(true);
    }
  });
});

describe('relay roles', () => {
  test('relay and relay,node are accepted role names', () => {
    expect(parseTmexRoleName('relay')).toBe('relay');
    expect(parseTmexRoleName('relay,node')).toBe('relay,node');
    expect(parseTmexRoles('relay')).toEqual({ hub: false, node: false, relay: true });
    expect(parseTmexRoles('relay,node')).toEqual({ hub: false, node: true, relay: true });
  });

  test('the error message lists the relay names', () => {
    expect(() => parseTmexRoleName('relay,hub')).toThrow(
      'role must be one of standalone | node | hub,node | relay | relay,node'
    );
  });

  test('validateRoles rejects hub together with relay', () => {
    expect(validateRoles({ hub: true, node: true, relay: true })).toContain('relay');
    expect(validateRoles({ hub: false, node: true, relay: true })).toBeNull();
  });
});

describe('relay env keys', () => {
  test('only relay roles get the relay keys', () => {
    expect(relayEnvDefaults({ role: 'node' })).toEqual({});
    expect(relayEnvDefaults({ role: 'hub,node' })).toEqual({});
    expect(relayEnvDefaults()).toEqual({});
  });

  test('a relay install gets a public url and a generated admin token', () => {
    const env = relayEnvDefaults({ role: 'relay', relayPublicUrl: 'https://r.example' });
    expect(env.TMEX_RELAY_PUBLIC_URL).toBe('https://r.example');
    expect(env.TMEX_RELAY_ADMIN_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('an explicit admin token is kept', () => {
    expect(
      relayEnvDefaults({ role: 'relay,node', relayAdminToken: 'keep-me' }).TMEX_RELAY_ADMIN_TOKEN
    ).toBe('keep-me');
  });

  test('generateRelayAdminToken produces 32 random bytes as base64url', () => {
    const first = generateRelayAdminToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(generateRelayAdminToken());
  });

  test('buildAppEnvValues folds the relay keys in for relay roles only', () => {
    const base = {
      host: '127.0.0.1',
      port: 9883,
      databasePath: '/tmp/x.db',
      masterKey: 'k',
    };
    expect(buildAppEnvValues({ ...base, role: 'node' }).TMEX_RELAY_ADMIN_TOKEN).toBeUndefined();
    const relay = buildAppEnvValues({
      ...base,
      role: 'relay',
      relayPublicUrl: 'https://r.example',
    });
    expect(relay.TMEX_ROLES).toBe('relay');
    expect(relay.TMEX_RELAY_PUBLIC_URL).toBe('https://r.example');
    expect(relay.TMEX_RELAY_ADMIN_TOKEN).toBeTruthy();
  });
});
