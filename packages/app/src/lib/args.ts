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
  | 'mesh.reset-root'
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

  if (command === 'init') return { name: 'init', rest: parsed.positionals, raw: command };
  if (command === 'doctor') return { name: 'doctor', rest: parsed.positionals, raw: command };
  if (command === 'upgrade') return { name: 'upgrade', rest: parsed.positionals, raw: command };
  if (command === 'uninstall') return { name: 'uninstall', rest: parsed.positionals, raw: command };
  if (command === 'enroll') return { name: 'enroll', rest: parsed.positionals, raw: command };
  if (command === 'direct') return { name: 'direct', rest: parsed.positionals, raw: command };

  if (command === 'hub') {
    const [head, second, third, ...tail] = parsed.positionals;
    if (head === 'leave') {
      return {
        name: 'hub.leave',
        rest: second ? ([second, third, ...tail].filter(Boolean) as string[]) : tail,
        raw: command,
      };
    }
    if (head === 'standby') {
      return {
        name: 'hub.standby',
        rest: [second, third, ...tail].filter((item): item is string => Boolean(item)),
        raw: command,
      };
    }
    if (head === 'promote') {
      return {
        name: 'hub.promote',
        rest: [second, third, ...tail].filter((item): item is string => Boolean(item)),
        raw: command,
      };
    }
    if (head === 'demote') {
      return {
        name: 'hub.demote',
        rest: [second, third, ...tail].filter((item): item is string => Boolean(item)),
        raw: command,
      };
    }
    if (head === 'list') {
      return {
        name: 'hub.list',
        rest: [second, third, ...tail].filter((item): item is string => Boolean(item)),
        raw: command,
      };
    }
    if (head === 'join') {
      return {
        name: 'hub.join',
        rest: [second, third, ...tail].filter((item): item is string => Boolean(item)),
        raw: command,
      };
    }
    if (head === 'user' && second === 'add') {
      return {
        name: 'hub.user.add',
        rest: [third, ...tail].filter((item): item is string => Boolean(item)),
        raw: command,
      };
    }
    if (head === 'user' && second === 'passwd') {
      return {
        name: 'hub.user.passwd',
        rest: [third, ...tail].filter((item): item is string => Boolean(item)),
        raw: command,
      };
    }
    if (head === 'user' && second === 'totp') {
      return {
        name: 'hub.user.totp',
        rest: [third, ...tail].filter((item): item is string => Boolean(item)),
        raw: command,
      };
    }
    if (head === 'user' && second === 'reset') {
      return {
        name: 'hub.user.reset',
        rest: [third, ...tail].filter((item): item is string => Boolean(item)),
        raw: command,
      };
    }
    return { name: 'unknown', rest: parsed.positionals, raw: command };
  }

  if (command === 'mesh') {
    const [head, ...rest] = parsed.positionals;
    if (head === 'reset-root') {
      return { name: 'mesh.reset-root', rest, raw: command };
    }
    return { name: 'unknown', rest: parsed.positionals, raw: command };
  }

  return { name: 'unknown', rest: parsed.positionals, raw: command };
}

const GLOBAL_FLAGS = new Set(['lang', 'help', 'h', 'bun-path']);

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
  uninstall: new Set([...GLOBAL_FLAGS, 'install-dir', 'yes', 'purge', 'service-name']),
  direct: new Set([...GLOBAL_FLAGS, 'install-dir']),
  enroll: new Set([...GLOBAL_FLAGS, 'install-dir', 'ttl', 'service-name']),
  'hub.join': new Set([
    ...GLOBAL_FLAGS,
    'install-dir',
    'token',
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
  'hub.user.add': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'no-interactive']),
  'hub.user.passwd': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'no-interactive']),
  'hub.user.totp': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'no-interactive']),
  'hub.user.reset': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'no-interactive']),
  'mesh.reset-root': new Set([...GLOBAL_FLAGS, 'install-dir', 'service-name', 'no-interactive']),
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
