// 命令注册表。新增命令组只需要在这里加一行；packages/app 的分发表读的也是这份名单。

import { command as api } from './commands/api';
import { command as cp } from './commands/cp';
import { command as devices } from './commands/devices';
import { command as files } from './commands/files';
import { command as login } from './commands/login';
import { command as logout } from './commands/logout';
import { command as nodes } from './commands/nodes';
import { command as port } from './commands/port';
import { command as settings } from './commands/settings';
import { command as share } from './commands/share';
import { command as term } from './commands/term';
import { command as tmux } from './commands/tmux';
import type { Command } from './commands/types';
import { command as watch } from './commands/watch';
import { command as whoami } from './commands/whoami';

export const IMPLEMENTED_COMMANDS: readonly Command[] = [
  login,
  logout,
  whoami,
  api,
  files,
  cp,
  port,
  nodes,
  devices,
  share,
  watch,
  settings,
  tmux,
  term,
];
/** 十四个组已全部落地；名单留着是为了 packages/app 的分发表与本表逐字对齐。 */
export const RESERVED_COMMANDS: readonly Command[] = [];
export const COMMANDS: readonly Command[] = [...IMPLEMENTED_COMMANDS, ...RESERVED_COMMANDS];

const BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

export function findCommand(name: string): Command | null {
  return BY_NAME.get(name) ?? null;
}

export function commandNames(): string[] {
  return COMMANDS.map((command) => command.name);
}
