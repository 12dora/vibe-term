import type { CommandSpec } from '@tmex/shared/messaging';
import { errorResult } from '../context';
import { resolvePaneRef } from '../resolve-refs';
import { requireDevice } from './device-tree';
import type { CommandHandler } from './types';

export const tailSpec: CommandSpec = {
  name: 'tail',
  aliases: [],
  args: [
    { name: 'device', required: true },
    { name: 'pane', required: true },
    { name: 'lines', required: false },
  ],
  descriptionKey: 'messaging.command.tail.description',
  requires: 'read',
};

const MAX_LINES = 200;
const DEFAULT_LINES = 30;

function parseLineCount(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return DEFAULT_LINES;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (value < 1 || value > MAX_LINES) return null;
  return value;
}

export const handleTail: CommandHandler = async (invocation, ctx) => {
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
  const lines = parseLineCount(invocation.args[2]);
  if (lines == null) {
    return errorResult(ctx, 'messaging.error.invalidLines');
  }
  try {
    const text = await ctx.capturePane(loaded.device.id, pane.pane.id, lines);
    return {
      sections: [{ code: true, lines: [text.length > 0 ? text : ctx.t('messaging.tail.empty')] }],
    };
  } catch {
    return errorResult(ctx, 'messaging.error.captureFailed');
  }
};
