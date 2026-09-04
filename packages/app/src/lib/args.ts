import { t } from '../i18n';
import type { ParsedArgs } from '../types';
import { UPGRADE_FLAGS } from './upgrade-flags';

export { UPGRADE_FLAGS, UPGRADE_PASSTHROUGH_FLAGS, UPGRADE_USAGE } from './upgrade-flags';

export type NestedCommandName =
  | 'init'
  | 'doctor'
  | 'upgrade'
  | 'uninstall'
  | 'help'
  | 'hub.user.add'
  | 'hub.user.passwd'
  | 'hub.user.totp'
  | 'hub.user.reset'
  | 'hub.join'
  | 'hub.leave'
  | 'hub.standby'
  | 'hub.promote'
  | 'hub.demote'
  | 'hub.list'
  | 'hub.allow'
  | 'hub.disallow'
  | 'mesh.reset-root'
  | 'relay.status'
  | 'relay.tenants'
  | 'relay.passwd'
  | 'relay.kick'
  | 'relay.remove'
  | 'relay.quota'
  | 'relay.label'
  | 'relay.enroll'
  | 'relay.reauth'
  | 'relay.leave'
  | 'relay.list'
  | 'relay.join'
  | 'enroll'
  | 'direct'
  | 'unknown';

export type NestedCommand = {
  name: NestedCommandName;
  rest: string[];
  raw: string | null;
};

export function parseArgs(argv: string[]): ParsedArgs {
  let command: string | null = null;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '-h') {
      flags.help = true;
      continue;
    }

    if (!token.startsWith('--')) {
      if (command === null) {
        command = token;
      } else {
        positionals.push(token);
      }
      continue;
    }

    if (token === '--help') {
      flags.help = true;
      continue;
    }

    const noPrefix = token.slice(2);
    const equalIndex = noPrefix.indexOf('=');

    if (equalIndex >= 0) {
      const key = noPrefix.slice(0, equalIndex);
      const value = noPrefix.slice(equalIndex + 1);
      flags[key] = value;
      continue;
    }

    const maybeNext = argv[index + 1];
    if (maybeNext && !maybeNext.startsWith('--')) {
      flags[noPrefix] = maybeNext;
      index += 1;
      continue;
    }

    flags[noPrefix] = true;
  }

  return {
    command,
    flags,
    positionals,
  };
}

const TOP_LEVEL_COMMANDS: Record<string, NestedCommandName> = {
  init: 'init',
  doctor: 'doctor',
  upgrade: 'upgrade',
  uninstall: 'uninstall',
  enroll: 'enroll',
  direct: 'direct',
};

const HUB_SUBCOMMANDS: Record<string, NestedCommandName> = {
  join: 'hub.join',
  leave: 'hub.leave',
  standby: 'hub.standby',
  promote: 'hub.promote',
  demote: 'hub.demote',
  list: 'hub.list',
  allow: 'hub.allow',
  disallow: 'hub.disallow',
};

const HUB_USER_SUBCOMMANDS: Record<string, NestedCommandName> = {
  add: 'hub.user.add',
  passwd: 'hub.user.passwd',
  totp: 'hub.user.totp',
  reset: 'hub.user.reset',
};

const RELAY_SUBCOMMANDS: Record<string, NestedCommandName> = {
  status: 'relay.status',
  tenants: 'relay.tenants',
  passwd: 'relay.passwd',
  kick: 'relay.kick',
  remove: 'relay.remove',
  quota: 'relay.quota',
  label: 'relay.label',
  enroll: 'relay.enroll',
  join: 'relay.join',
  reauth: 'relay.reauth',
  leave: 'relay.leave',
  list: 'relay.list',
};

const MESH_SUBCOMMANDS: Record<string, NestedCommandName> = {
  'reset-root': 'mesh.reset-root',
};

function group(
  table: Record<string, NestedCommandName>,
  parsed: ParsedArgs,
  raw: string,
  depth: number
): NestedCommand {
  const name = table[parsed.positionals[depth - 1] ?? ''];
  if (!name) return { name: 'unknown', rest: parsed.positionals, raw };
  return { name, rest: parsed.positionals.slice(depth), raw };
}

export function resolveNestedCommand(parsed: ParsedArgs): NestedCommand {
  const command = parsed.command;
  if (
    command === null ||
    command === undefined ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    return { name: 'help', rest: parsed.positionals, raw: command };
  }

  const topLevel = TOP_LEVEL_COMMANDS[command];
  if (topLevel) return { name: topLevel, rest: parsed.positionals, raw: command };

  if (command === 'hub') {
    if (parsed.positionals[0] === 'user') return group(HUB_USER_SUBCOMMANDS, parsed, command, 2);
    return group(HUB_SUBCOMMANDS, parsed, command, 1);
  }
  if (command === 'relay') return group(RELAY_SUBCOMMANDS, parsed, command, 1);
  if (command === 'mesh') return group(MESH_SUBCOMMANDS, parsed, command, 1);

  return { name: 'unknown', rest: parsed.positionals, raw: command };
}

const GLOBAL_FLAGS = new Set(['lang', 'help', 'h', 'bun-path']);

const RELAY_ADMIN_FLAGS = new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'json']);

const RELAY_TENANT_FLAGS = new Set([
  ...GLOBAL_FLAGS,
  'install-dir',
  'service-name',
  'password',
  'username',
]);

const COMMAND_FLAGS: Record<NestedCommandName, ReadonlySet<string>> = {
  help: GLOBAL_FLAGS,
  unknown: GLOBAL_FLAGS,
  init: new Set([
    ...GLOBAL_FLAGS,
    'install-dir',
    'host',
    'port',
    'db-path',
    'autostart',
    'service-name',
    'force',
    'no-interactive',
    'install-deps',
    'skip-dep-check',
    'role',
    'hub-url',
    'hub-public-url',
    'relay-public-url',
    'peer-port',
    'stun-servers',
    'no-service',
  ]),
  doctor: new Set([
    ...GLOBAL_FLAGS,
    'install-dir',
    'json',
    'fix',
    'service-name',
    'no-interactive',
  ]),
  upgrade: UPGRADE_FLAGS,
  uninstall: new Set([...GLOBAL_FLAGS, 'install-dir', 'yes', 'purge', 'service-name', 'delay-ms']),
  direct: new Set([...GLOBAL_FLAGS, 'install-dir']),
  enroll: new Set([...GLOBAL_FLAGS, 'install-dir', 'ttl', 'service-name']),
  'hub.join': new Set([
    ...GLOBAL_FLAGS,
    'install-dir',
    'token',
    'password',
    'totp',
    'name',
    'insecure-local',
    'no-restart',
    'service-name',
  ]),
  'hub.leave': new Set([...GLOBAL_FLAGS, 'install-dir', 'no-restart', 'service-name']),
  'hub.standby': new Set([
    ...GLOBAL_FLAGS,
    'install-dir',
    'public-url',
    'priority',
    'insecure-local',
    'no-restart',
    'service-name',
  ]),
  'hub.promote': new Set([
    ...GLOBAL_FLAGS,
    'install-dir',
    'yes',
    'no-restart',
    'no-interactive',
    'service-name',
  ]),
  'hub.demote': new Set([...GLOBAL_FLAGS, 'install-dir', 'no-restart', 'service-name']),
  'hub.list': new Set([...GLOBAL_FLAGS, 'install-dir']),
  'hub.allow': new Set([...GLOBAL_FLAGS, 'install-dir', 'no-restart', 'service-name']),
  'hub.disallow': new Set([...GLOBAL_FLAGS, 'install-dir', 'no-restart', 'service-name']),
  'hub.user.add': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'no-interactive']),
  'hub.user.passwd': new Set([
    ...GLOBAL_FLAGS,
    'install-dir',
    'service-name',
    'no-interactive',
    'full-reset',
  ]),
  'hub.user.totp': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'no-interactive']),
  'hub.user.reset': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'no-interactive']),
  'mesh.reset-root': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'no-interactive']),
  'relay.status': RELAY_ADMIN_FLAGS,
  'relay.tenants': RELAY_ADMIN_FLAGS,
  'relay.passwd': new Set([...RELAY_ADMIN_FLAGS, 'clear', 'kick', 'keep']),
  'relay.kick': RELAY_ADMIN_FLAGS,
  'relay.remove': new Set([...RELAY_ADMIN_FLAGS, 'yes']),
  'relay.quota': new Set([
    ...RELAY_ADMIN_FLAGS,
    'max-nodes',
    'max-streams',
    'bandwidth',
    'inherit',
  ]),
  'relay.label': RELAY_ADMIN_FLAGS,
  'relay.enroll': RELAY_TENANT_FLAGS,
  'relay.join': new Set([
    ...GLOBAL_FLAGS,
    'install-dir',
    'service-name',
    'tenant',
    'password',
    'name',
    'ca-fingerprint',
    'no-restart',
  ]),
  'relay.reauth': RELAY_TENANT_FLAGS,
  'relay.leave': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name']),
  'relay.list': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'json']),
};

export function assertKnownFlags(parsed: ParsedArgs): void {
  const nested = resolveNestedCommand(parsed);
  const allowed = COMMAND_FLAGS[nested.name] ?? GLOBAL_FLAGS;
  for (const key of Object.keys(parsed.flags)) {
    if (!allowed.has(key)) {
      throw new Error(t('cli.error.unknownFlag', { flag: key }));
    }
  }
}
