import { roleNameFromFlags } from '@tmex/shared';
import type { CommandSpec } from '@tmex/shared/messaging';
import type { UplinkStatus } from '../context';
import type { CommandHandler } from './types';

export const statusSpec: CommandSpec = {
  name: 'status',
  aliases: [],
  args: [],
  descriptionKey: 'messaging.command.status.description',
  requires: 'read',
};

function uplinkKindLabel(t: (key: string) => string, kind: UplinkStatus['kind']): string {
  if (kind === 'hub') return t('messaging.status.uplinkHub');
  if (kind === 'relay') return t('messaging.status.uplinkRelay');
  if (kind === 'none') return t('messaging.status.uplinkNone');
  return t('messaging.status.uplinkUnknown');
}

function attachedLabel(t: (key: string) => string, attached: boolean | 'unknown'): string {
  if (attached === true) return t('messaging.status.attached');
  if (attached === false) return t('messaging.status.detached');
  return t('messaging.status.attachedUnknown');
}

export const handleStatus: CommandHandler = async (_invocation, ctx) => {
  const lines = [
    `${ctx.t('messaging.status.name')}: ${ctx.localName}`,
    `${ctx.t('messaging.status.version')}: ${ctx.version}`,
    `${ctx.t('messaging.status.roles')}: ${roleNameFromFlags(ctx.roles)}`,
    `${ctx.t('messaging.status.uplink')}: ${uplinkKindLabel(ctx.t, ctx.uplink.kind)} (${attachedLabel(ctx.t, ctx.uplink.attached)})`,
  ];
  return { sections: [{ lines }] };
};
