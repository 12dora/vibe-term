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
  | 'user.add'
  | 'user.passwd'
  | 'user.totp'
  | 'mesh.reset-identity'
  | 'tls.reset'
  | 'mesh.keylog.status'
  | 'mesh.reset-root'
  | 'mesh.passkey.remove-all'
  | 'relay.status'
  | 'relay.tenants'
  | 'relay.metrics'
  | 'relay.passwd'
  | 'relay.kick'
  | 'relay.remove'
  | 'relay.quota'
  | 'relay.limits'
  | 'relay.label'
  | 'relay.enroll'
  | 'relay.reauth'
  | 'relay.pack.upload'
  | 'relay.resend-token'
  | 'relay.leave'
  | 'relay.list'
  | 'relay.unpin'
  | 'relay.join'
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
  direct: 'direct',
};

const USER_SUBCOMMANDS: Record<string, NestedCommandName> = {
  add: 'user.add',
  passwd: 'user.passwd',
  totp: 'user.totp',
};

const RELAY_SUBCOMMANDS: Record<string, NestedCommandName> = {
  status: 'relay.status',
  tenants: 'relay.tenants',
  metrics: 'relay.metrics',
  passwd: 'relay.passwd',
  kick: 'relay.kick',
  remove: 'relay.remove',
  quota: 'relay.quota',
  limits: 'relay.limits',
  label: 'relay.label',
  enroll: 'relay.enroll',
  join: 'relay.join',
  reauth: 'relay.reauth',
  'resend-token': 'relay.resend-token',
  leave: 'relay.leave',
  list: 'relay.list',
  unpin: 'relay.unpin',
};

const MESH_SUBCOMMANDS: Record<string, NestedCommandName> = {
  'reset-root': 'mesh.reset-root',
  'reset-identity': 'mesh.reset-identity',
};

const MESH_PASSKEY_SUBCOMMANDS: Record<string, NestedCommandName> = {
  'remove-all': 'mesh.passkey.remove-all',
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

  const nestedGroups: Record<string, Record<string, NestedCommandName>> = {
    'relay.pack': { upload: 'relay.pack.upload' },
    'mesh.keylog': { status: 'mesh.keylog.status' },
    'mesh.passkey': MESH_PASSKEY_SUBCOMMANDS,
  };
  const nestedGroup = nestedGroups[`${command}.${parsed.positionals[0]}`];
  if (nestedGroup) return group(nestedGroup, parsed, command, 2);
  const groups: Record<string, Record<string, NestedCommandName>> = {
    user: USER_SUBCOMMANDS,
    relay: RELAY_SUBCOMMANDS,
    'relay-admin': { passwd: 'relay.passwd', kick: 'relay.kick' },
    mesh: MESH_SUBCOMMANDS,
    tls: { reset: 'tls.reset' },
  };
  const commandGroup = groups[command];
  if (commandGroup) return group(commandGroup, parsed, command, 1);

  return { name: 'unknown', rest: parsed.positionals, raw: command };
}

const GLOBAL_FLAGS = new Set(['lang', 'help', 'h', 'bun-path']);

export { STUN_SERVERS_FLAG_HELP } from '../cli/help';

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
    'replace-shim',
    'no-interactive',
    'install-deps',
    'skip-dep-check',
    'role',
    'relay-public-url',
    'public-port',
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
  'user.add': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'no-interactive']),
  'user.passwd': new Set([
    ...GLOBAL_FLAGS,
    'install-dir',
    'service-name',
    'no-interactive',
    'full-reset',
    'yes',
  ]),
  'user.totp': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'no-interactive']),
  'mesh.reset-root': new Set([
    ...GLOBAL_FLAGS,
    'install-dir',
    'service-name',
    'no-interactive',
    'yes',
  ]),
  'mesh.reset-identity': new Set([...GLOBAL_FLAGS, 'install-dir', 'yes', 'reset-tls']),
  'tls.reset': new Set([...GLOBAL_FLAGS, 'install-dir', 'yes']),
  'mesh.keylog.status': new Set([...GLOBAL_FLAGS, 'install-dir']),
  'mesh.passkey.remove-all': new Set([
    ...GLOBAL_FLAGS,
    'install-dir',
    'service-name',
    'no-interactive',
  ]),
  'relay.status': RELAY_ADMIN_FLAGS,
  'relay.tenants': RELAY_ADMIN_FLAGS,
  'relay.metrics': new Set([...RELAY_ADMIN_FLAGS, 'members']),
  'relay.passwd': new Set([...RELAY_ADMIN_FLAGS, 'clear', 'kick', 'keep', 'force']),
  'relay.kick': new Set([...RELAY_ADMIN_FLAGS, 'force']),
  'relay.remove': new Set([...RELAY_ADMIN_FLAGS, 'yes']),
  'relay.quota': new Set([
    ...RELAY_ADMIN_FLAGS,
    'max-nodes',
    'max-streams',
    'bandwidth',
    'max-file-mb',
    'inherit',
  ]),
  'relay.limits': new Set([
    ...RELAY_ADMIN_FLAGS,
    'max-tenants',
    'total-bandwidth-kb',
    'fair-share',
  ]),
  'relay.label': RELAY_ADMIN_FLAGS,
  'relay.enroll': RELAY_TENANT_FLAGS,
  'relay.join': new Set([
    ...GLOBAL_FLAGS,
    'install-dir',
    'service-name',
    'token',
    'tenant',
    'password',
    'name',
    'ca-fingerprint',
    'no-restart',
  ]),
  'relay.reauth': RELAY_TENANT_FLAGS,
  'relay.pack.upload': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name']),
  'relay.resend-token': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name']),
  'relay.leave': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name']),
  'relay.list': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'json']),
  'relay.unpin': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'json']),
};

/**
 * 取一个必须带值的旗标。光秃秃的 `--flag`（被解析成 true）和空串都算「给了但没给值」，
 * 直接报用法错误——否则会被当成压根没给这个旗标，用户要求的改动被静默丢掉。
 */
export function requireFlagValue(
  flags: Readonly<Record<string, string | boolean>>,
  key: string
): string | undefined {
  if (!Object.hasOwn(flags, key)) return undefined;
  const value = flags[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(t('errors.validate.emptyField', { field: `--${key}` }));
  }
  return value;
}

export function assertKnownFlags(parsed: ParsedArgs): void {
  const nested = resolveNestedCommand(parsed);
  const allowed = COMMAND_FLAGS[nested.name] ?? GLOBAL_FLAGS;
  for (const key of Object.keys(parsed.flags)) {
    if (!allowed.has(key)) {
      throw new Error(t('cli.error.unknownFlag', { flag: key }));
    }
  }
}
