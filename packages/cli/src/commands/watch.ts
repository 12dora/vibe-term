// `vibeterm watch`：终端 watch 规则。

import { flagString } from '../core/args';
import {
  type SubHandler,
  confirmOrYes,
  emit,
  parseOnOff,
  rejectExtra,
  requireArg,
  runSubs,
  shortId,
  yn,
} from '../core/cmd';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import { watchRuleBody } from '../core/watch-body';
import type { Command } from './types';

const FLAGS = {
  name: 'string',
  device: 'string',
  pane: 'string',
  'trigger-type': 'string',
  pattern: 'string',
  flags: 'string',
  enabled: 'boolean',
  disabled: 'boolean',
  interval: 'number',
  cooldown: 'number',
  'fire-mode': 'string',
  'unchanged-minutes': 'number',
  'no-match': 'string',
  prompt: 'string',
  body: 'string',
  yes: 'boolean',
  'provider-id': 'string',
  'model-id': 'string',
} as const;

const USAGE = [
  'Usage: vibeterm watch rules <subcommand>',
  '',
  'Subcommands:',
  '  rules ls --device <id> --pane <id>',
  '  rules show <id>',
  '  rules add --name --device --pane --trigger-type match|unchanged|llm [--pattern] [--body]',
  '  rules edit <id> …',
  '  rules rm <id> [--yes]',
  '  rules state <id> [on|off]     GET state; with on|off PATCH enabled',
  '  assist-regex "<description>" [--device] [--pane]',
  '',
  '--json: { rules } / { rule, state } / WatchRuleStateResponse / AssistRegexResponse',
].join('\n');

function rulePath(id: string, suffix = ''): string {
  return `/api/watch/rules/${encodeURIComponent(id)}${suffix}`;
}

const rules: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'rules action');
  const rest = positionals.slice(1);
  const nodeId = await ctx.targetNodeId();
  if (action === 'ls') {
    const deviceId = flagString(flags, 'device');
    const paneId = flagString(flags, 'pane');
    if (!deviceId || !paneId) throw new UsageError('rules ls requires --device and --pane');
    const params = new URLSearchParams({ deviceId, paneId });
    const payload = await ctx.http.json<{
      rules?: Array<
        Record<string, unknown> & {
          id: string;
          name: string;
          enabled: boolean;
          triggerType: string;
        }
      >;
    }>(nodeId, 'GET', `/api/watch/rules?${params}`);
    const rows = payload.rules ?? [];
    emit(ctx, payload, () => {
      ctx.out.table(rows, [
        { header: 'ID', value: (row) => shortId(row.id) },
        { header: 'NAME', value: (row) => row.name },
        { header: 'ON', value: (row) => yn(row.enabled) },
        { header: 'TRIGGER', value: (row) => row.triggerType },
      ]);
    });
    return;
  }
  if (action === 'show') {
    const id = requireArg(rest, 0, 'rule id');
    rejectExtra(rest, 1);
    const payload = await ctx.http.json(nodeId, 'GET', rulePath(id));
    emit(ctx, payload, () => ctx.out.data(payload));
    return;
  }
  if (action === 'add') {
    const body = await watchRuleBody(flags, {
      name: true,
      device: true,
      pane: true,
      trigger: true,
    });
    const payload = await ctx.http.json(nodeId, 'POST', '/api/watch/rules', body);
    emit(ctx, payload, () => ctx.out.data(payload));
    return;
  }
  if (action === 'edit') {
    const id = requireArg(rest, 0, 'rule id');
    const body = await watchRuleBody(flags, {});
    const payload = await ctx.http.json(nodeId, 'PATCH', rulePath(id), body);
    emit(ctx, payload, () => ctx.out.data(payload));
    return;
  }
  if (action === 'rm') {
    const id = requireArg(rest, 0, 'rule id');
    await confirmOrYes(flags, `delete watch rule ${id}`);
    await ctx.http.json(nodeId, 'DELETE', rulePath(id));
    emit(ctx, { ok: true, id }, () => ctx.out.line(`deleted ${id}`));
    return;
  }
  if (action === 'state') {
    const id = requireArg(rest, 0, 'rule id');
    const toggle = rest[1];
    if (toggle) {
      const enabled = parseOnOff(toggle);
      const payload = await ctx.http.json(nodeId, 'PATCH', rulePath(id), { enabled });
      emit(ctx, payload, () => ctx.out.data(payload));
      return;
    }
    const payload = await ctx.http.json(nodeId, 'GET', rulePath(id, '/state'));
    emit(ctx, payload, () => ctx.out.data(payload));
    return;
  }
  throw new UsageError(`unknown rules action: ${action}`, 'use ls|show|add|edit|rm|state');
};

const assistRegex: SubHandler = async (ctx, flags, positionals) => {
  const description = requireArg(positionals, 0, 'description');
  rejectExtra(positionals, 1);
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json(nodeId, 'POST', '/api/watch/assist-regex', {
    description,
    deviceId: flagString(flags, 'device') ?? undefined,
    paneId: flagString(flags, 'pane') ?? undefined,
    providerId: flagString(flags, 'provider-id') ?? null,
    modelId: flagString(flags, 'model-id') ?? null,
  });
  emit(ctx, payload, () => ctx.out.data(payload));
};

const HANDLERS: Record<string, SubHandler> = {
  rules,
  'assist-regex': assistRegex,
};

export const command: Command = {
  name: 'watch',
  summary: 'manage watch rules',
  usage: USAGE,
  flags: FLAGS,
  run: (ctx, argv) => runSubs(ctx, argv, FLAGS, HANDLERS, 'run: vibeterm watch --help'),
};
