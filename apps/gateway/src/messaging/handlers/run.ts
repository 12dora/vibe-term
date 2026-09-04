import type { CommandSpec } from '@tmex/shared/messaging';
import { errorResult } from '../context';
import { resolvePaneRef } from '../resolve-refs';
import { requireDevice } from './device-tree';
import type { CommandHandler } from './types';

export const runSpec: CommandSpec = {
  name: 'run',
  aliases: [],
  args: [
    { name: 'device', required: true },
    { name: 'pane', required: true },
    { name: 'text', required: true, rest: true },
  ],
  descriptionKey: 'messaging.command.run.description',
  requires: 'execute',
};

export const handleRun: CommandHandler = async (invocation, ctx) => {
  const loaded = requireDevice(invocation.args[0], ctx);
  if (!loaded.ok) return loaded.result;
  const paneArg = invocation.args[1];
  if (!paneArg) {
    return errorResult(ctx, 'messaging.error.missingArg', { name: 'pane' });
  }
  const pane = resolvePaneRef(paneArg, loaded.windows);
  if (!pane.ok) {
    const code =
      pane.error === 'ambiguous' ? 'messaging.error.ambiguousPane' : 'messaging.error.unknownPane';
    return errorResult(ctx, code, {
      input: pane.input,
      candidates: pane.candidates.join(', '),
    });
  }
  const text = invocation.tail?.trim() ?? '';
  if (!text) {
    return errorResult(ctx, 'messaging.error.missingTail');
  }
  try {
    await ctx.sendKeys(loaded.device.id, pane.pane.id, `${text}\r`);
    return { text: ctx.t('messaging.run.sent') };
  } catch {
    return errorResult(ctx, 'messaging.error.sendFailed');
  }
};
