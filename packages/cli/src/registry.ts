// 命令注册表。新增命令组只需要在这里加一行；packages/app 的分发表读的也是这份名单。

import { command as api } from './commands/api';
import { command as login } from './commands/login';
import { command as logout } from './commands/logout';
import type { Command } from './commands/types';
import { command as whoami } from './commands/whoami';
import { CliError, EXIT_USAGE } from './core/errors';

/**
 * 已占位但还没实现的命令组：名字先在这里登记，`vibeterm <group>` 才会给出一句人话
 * （而不是「未知命令」），也让 packages/app 的分发表一次到位、以后不用再改。
 */
interface ReservedSpec {
  name: string;
  summary: string;
  /** 该组落地前的 REST 替代路径。 */
  escape: string;
}

const RESERVED_SPECS: readonly ReservedSpec[] = [
  {
    name: 'nodes',
    summary: 'inspect and manage mesh nodes',
    escape: 'vibeterm api GET /api/mesh/nodes',
  },
  { name: 'devices', summary: 'manage devices on a node', escape: 'vibeterm api GET /api/devices' },
  {
    name: 'tmux',
    summary: 'inspect and drive tmux windows and panes',
    escape: 'vibeterm api GET /api/devices',
  },
  {
    name: 'term',
    summary: 'attach to, send keys to and capture a pane',
    escape: 'vibeterm api GET /api/devices',
  },
  { name: 'files', summary: 'browse files on a node', escape: 'vibeterm api GET /api/files/roots' },
  {
    name: 'cp',
    summary: 'copy files between this machine and nodes',
    escape: 'vibeterm api GET /api/transfer/sessions',
  },
  { name: 'port', summary: 'manage port maps', escape: 'vibeterm api GET /api/portmap' },
  { name: 'share', summary: 'manage terminal shares', escape: 'vibeterm api GET /api/share' },
  { name: 'watch', summary: 'manage watch rules', escape: 'vibeterm api GET /api/watch/rules' },
  {
    name: 'settings',
    summary: 'read and write site settings',
    escape: 'vibeterm api GET /api/settings',
  },
];

function reservedCommand(spec: ReservedSpec): Command {
  const message = `"vibeterm ${spec.name}" is reserved but not implemented in this build`;
  return {
    name: spec.name,
    summary: `${spec.summary} (reserved, not implemented yet)`,
    usage: [
      `Usage: vibeterm ${spec.name} …`,
      '',
      message,
      '',
      `Until it ships: ${spec.escape}`,
    ].join('\n'),
    async run() {
      throw new CliError(message, EXIT_USAGE, `until it ships: ${spec.escape}`);
    },
  };
}

export const IMPLEMENTED_COMMANDS: readonly Command[] = [login, logout, whoami, api];
export const RESERVED_COMMANDS: readonly Command[] = RESERVED_SPECS.map(reservedCommand);
export const COMMANDS: readonly Command[] = [...IMPLEMENTED_COMMANDS, ...RESERVED_COMMANDS];

const BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

export function findCommand(name: string): Command | null {
  return BY_NAME.get(name) ?? null;
}

export function commandNames(): string[] {
  return COMMANDS.map((command) => command.name);
}
