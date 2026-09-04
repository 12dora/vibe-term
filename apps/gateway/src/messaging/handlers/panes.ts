import type { CommandSpec } from '@tmex/shared/messaging';
import { errorResult } from '../context';
import { findWindow } from '../resolve-refs';
import { requireDevice } from './device-tree';
import type { CommandHandler } from './types';

export const panesSpec: CommandSpec = {
  name: 'panes',
  aliases: [],
  args: [
    { name: 'device', required: true },
    { name: 'window', required: false },
  ],
  descriptionKey: 'messaging.command.panes.description',
  requires: 'read',
};

export const handlePanes: CommandHandler = async (invocation, ctx) => {
  const loaded = requireDevice(invocation.args[0], ctx);
  if (!loaded.ok) return loaded.result;
  const windowRef = findWindow(invocation.args[1], loaded.windows);
  if (!windowRef.ok) {
    const code =
      windowRef.error === 'ambiguous'
        ? 'messaging.error.ambiguousWindow'
        : 'messaging.error.unknownWindow';
    return errorResult(ctx, code, {
      input: windowRef.input,
      candidates: windowRef.candidates.join(', '),
    });
  }
  const windows = windowRef.window ? [windowRef.window] : loaded.windows;
  const lines = windows.flatMap((window) =>
    window.panes.map((pane) => {
      const active = pane.active ? ' *' : '';
      const title = pane.title ? ` ${pane.title}` : '';
      return `${window.index}.${pane.index} ${pane.id}${title}${active}`;
    })
  );
  if (lines.length === 0) return { text: ctx.t('messaging.panes.empty') };
  return { sections: [{ lines }] };
};
