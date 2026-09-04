import type { CommandSpec } from '@tmex/shared/messaging';
import { errorResult } from '../context';
import type { CommandHandler } from './types';

export const approveSpec: CommandSpec = {
  name: 'approve',
  aliases: [],
  args: [{ name: 'confirmationId', required: true }],
  descriptionKey: 'messaging.command.approve.description',
  requires: 'approve',
};

export const denySpec: CommandSpec = {
  name: 'deny',
  aliases: [],
  args: [
    { name: 'confirmationId', required: true },
    { name: 'reason', required: false, rest: true },
  ],
  descriptionKey: 'messaging.command.deny.description',
  requires: 'approve',
};

function confirmationError(
  ctx: Parameters<CommandHandler>[1],
  code: 'notFound' | 'alreadyDecided' | 'unavailable'
) {
  if (code === 'alreadyDecided')
    return errorResult(ctx, 'messaging.error.confirmationAlreadyDecided');
  if (code === 'unavailable') return errorResult(ctx, 'messaging.error.confirmationUnavailable');
  return errorResult(ctx, 'messaging.error.confirmationNotFound');
}

export const handleApprove: CommandHandler = async (invocation, ctx) => {
  const id = invocation.args[0];
  if (!id) return errorResult(ctx, 'messaging.error.missingArg', { name: 'confirmationId' });
  const decided = ctx.decideConfirmation(id, true);
  if (!decided.ok) return confirmationError(ctx, decided.code);
  return { text: ctx.t('messaging.approve.ok') };
};

export const handleDeny: CommandHandler = async (invocation, ctx) => {
  const id = invocation.args[0];
  if (!id) return errorResult(ctx, 'messaging.error.missingArg', { name: 'confirmationId' });
  const reason = invocation.tail?.trim() || invocation.args.slice(1).join(' ').trim() || undefined;
  const decided = ctx.decideConfirmation(id, false, reason);
  if (!decided.ok) return confirmationError(ctx, decided.code);
  return { text: ctx.t('messaging.deny.ok') };
};
