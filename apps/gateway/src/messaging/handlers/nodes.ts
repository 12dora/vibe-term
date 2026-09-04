import type { CommandSpec } from '@tmex/shared/messaging';
import type { CommandHandler } from './types';

export const nodesSpec: CommandSpec = {
  name: 'nodes',
  aliases: [],
  args: [],
  descriptionKey: 'messaging.command.nodes.description',
  requires: 'read',
};

export const handleNodes: CommandHandler = async (_invocation, ctx) => {
  if (ctx.meshMode === 'standalone') {
    return { text: ctx.t('messaging.nodes.standalone') };
  }
  const lines = ctx.listNodes().map((node) => {
    const state = node.online ? ctx.t('messaging.nodes.online') : ctx.t('messaging.nodes.offline');
    const version = node.version ?? ctx.t('messaging.nodes.unknownVersion');
    const current = node.current ? ` [${ctx.t('messaging.nodes.current')}]` : '';
    return `${node.name} · ${state} · ${version}${current}`;
  });
  return {
    sections: [{ title: ctx.t('messaging.nodes.title'), lines }],
  };
};
