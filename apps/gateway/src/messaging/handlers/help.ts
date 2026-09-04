import type { CommandSpec } from '@tmex/shared/messaging';
import { formatArgUsage } from '../context';
import type { CommandHandler } from './types';

export const helpSpec: CommandSpec = {
  name: 'help',
  aliases: [],
  args: [],
  descriptionKey: 'messaging.command.help.description',
  requires: 'read',
};

export const handleHelp: CommandHandler = async (_invocation, ctx) => {
  const lines = ctx.registry.list().map((spec) => {
    return `${formatArgUsage(spec)} — ${ctx.t(spec.descriptionKey)}`;
  });
  return {
    sections: [{ title: ctx.t('messaging.help.title'), lines }],
  };
};
