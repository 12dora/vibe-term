import type { CommandSpec } from '@tmex/shared/messaging';
import { requireDevice } from './device-tree';
import type { CommandHandler } from './types';

export const windowsSpec: CommandSpec = {
  name: 'windows',
  aliases: [],
  args: [{ name: 'device', required: true }],
  descriptionKey: 'messaging.command.windows.description',
  requires: 'read',
};

export const handleWindows: CommandHandler = async (invocation, ctx) => {
  const loaded = requireDevice(invocation.args[0], ctx);
  if (!loaded.ok) return loaded.result;
  if (loaded.windows.length === 0) {
    return { text: ctx.t('messaging.windows.empty') };
  }
  const lines = loaded.windows.map((window) => {
    const active = window.active ? ' *' : '';
    return `${window.index}: ${window.name}${active}`;
  });
  return { sections: [{ lines }] };
};
