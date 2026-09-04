import type { CommandInvocation, CommandResult, CommandSpec } from '@tmex/shared/messaging';
import type { CommandContext } from '../context';

export type CommandHandler = (
  invocation: CommandInvocation,
  ctx: CommandContext
) => Promise<CommandResult>;

export interface CommandModule {
  spec: CommandSpec;
  handle: CommandHandler;
}
