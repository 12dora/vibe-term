import type { CommandInvocation, CommandResult } from '@tmex/shared/messaging';
import type { CommandContext } from '../context';

export type CommandHandler = (
  invocation: CommandInvocation,
  ctx: CommandContext
) => Promise<CommandResult>;
