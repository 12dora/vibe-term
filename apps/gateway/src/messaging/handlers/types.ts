import type { CommandInvocation, CommandResult } from '@vibeterm/shared/messaging';
import type { CommandContext } from '../context';

export type CommandHandler = (
  invocation: CommandInvocation,
  ctx: CommandContext
) => Promise<CommandResult>;
