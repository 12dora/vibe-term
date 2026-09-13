import { describe, expect, test } from 'bun:test';
import { findCommandToken } from './main';
import {
  COMMANDS,
  IMPLEMENTED_COMMANDS,
  RESERVED_COMMANDS,
  commandNames,
  findCommand,
} from './registry';

/** packages/app 的分发表必须与这份名单逐字一致，否则会出现路由得到、但 CLI 不认的组。 */
const DISPATCHED_GROUPS = [
  'login',
  'logout',
  'whoami',
  'api',
  'nodes',
  'devices',
  'tmux',
  'term',
  'files',
  'cp',
  'port',
  'share',
  'watch',
  'agent',
  'settings',
];

describe('registry', () => {
  test('covers exactly the groups packages/app dispatches', () => {
    expect(commandNames().sort()).toEqual([...DISPATCHED_GROUPS].sort());
  });

  test('every command has a summary and a usage block', () => {
    for (const command of COMMANDS) {
      expect(command.summary.length).toBeGreaterThan(0);
      expect(command.usage).toContain(`vibeterm ${command.name}`);
    }
  });

  test('every dispatched group is implemented, nothing is left reserved', () => {
    const names = IMPLEMENTED_COMMANDS.map((command) => command.name);
    expect(names.sort()).toEqual([...DISPATCHED_GROUPS].sort());
    expect(RESERVED_COMMANDS).toHaveLength(0);
  });

  test('findCommand only knows registered names', () => {
    expect(findCommand('login')?.name).toBe('login');
    expect(findCommand('nope')).toBeNull();
  });
});

describe('findCommandToken', () => {
  test('finds the command after global flags', () => {
    expect(findCommandToken(['--entry', 'http://x:1', 'whoami'])).toEqual({
      name: 'whoami',
      index: 2,
    });
  });

  test('does not mistake a flag value for the command', () => {
    expect(findCommandToken(['--node', 'office', 'api', 'GET', '/x']).name).toBe('api');
  });

  test('inline values keep the next token available', () => {
    expect(findCommandToken(['--node=office', 'api']).name).toBe('api');
  });

  test('returns null when there is no command', () => {
    expect(findCommandToken(['--help'])).toEqual({ name: null, index: -1 });
  });
});
