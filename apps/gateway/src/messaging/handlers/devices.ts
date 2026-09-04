import type { CommandSpec } from '@tmex/shared/messaging';
import type { CommandHandler } from './types';

export const devicesSpec: CommandSpec = {
  name: 'devices',
  aliases: [],
  args: [{ name: 'node', required: false }],
  descriptionKey: 'messaging.command.devices.description',
  requires: 'read',
};

export const handleDevices: CommandHandler = async (_invocation, ctx) => {
  const devices = ctx.listDevices();
  if (devices.length === 0) {
    return { text: ctx.t('messaging.devices.empty') };
  }
  const lines = devices.map((device) => {
    const state = device.connected
      ? ctx.t('messaging.devices.connected')
      : ctx.t('messaging.devices.disconnected');
    return `${device.name} · ${device.type} · ${state}`;
  });
  return { sections: [{ lines }] };
};
