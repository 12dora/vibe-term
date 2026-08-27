import type { ParsedArgs } from '../types';

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

    if (!token.startsWith('--')) {
      if (command === null) {
        command = token;
      } else {
        positionals.push(token);
      }
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
