// `vibeterm share`：终端分享。

import { flagBool, flagNumber, flagString } from '../core/args';
import {
  type SubHandler,
  confirmOrYes,
  dash,
  emit,
  mergeBody,
  parseDurationMs,
  readSecretField,
  rejectExtra,
  requireArg,
  requireObjectBody,
  resolveJsonBody,
  runSubs,
  shortId,
} from '../core/cmd';
import type { CliContext } from '../core/context';
import { NotFoundError, UsageError } from '../core/errors';
import { resolveShareTarget, sharePath } from '../core/share-target';
import type { Command } from './types';

const FLAGS = {
  password: 'string',
  'password-stdin': 'boolean',
  'password-file': 'string',
  name: 'string',
  'window-id': 'string',
  origin: 'string',
  expires: 'string',
  yes: 'boolean',
  body: 'string',
  after: 'number',
  limit: 'number',
  'end-sessions': 'boolean',
} as const;

const USAGE = [
  'Usage: vibeterm share <subcommand>',
  '',
  'Subcommands:',
  '  create <target-window> [--password] [--name] [--expires 1h] [--origin] [--window-id @N]',
  '  ls [--node]',
  '  show <id>',
  '  password <id> [--password] [--end-sessions]   GET; POST sets password (API cannot clear it)',
  '  revoke <id>                            POST /api/share/:id/revoke',
  '  rm <id>                                DELETE (ended shares only)',
  '  log <id> [--after N] [--limit N]',
  '  settings get|set                       GET/PUT /api/share/settings; set needs --body',
  '  origins                                GET /api/share/origins',
  '',
  'create target: [<node>/]<device>:<window>  window is a tmux id (@1) or name.',
  'Secrets: --password-stdin / --password-file / @file / VIBETERM_SHARE_PASSWORD (argv warns).',
  '--json: { share, password } / { active, history } / ShareRecord / ShareLogPage / ShareSettings',
].join('\n');

async function readSharePassword(
  ctx: CliContext,
  flags: Parameters<SubHandler>[1]
): Promise<string> {
  const value = await readSecretField(ctx, flags, {
    flag: 'password',
    envName: 'VIBETERM_SHARE_PASSWORD',
    required: true,
    prompt: 'Share password: ',
  });
  return value as string;
}

const create: SubHandler = async (ctx, flags, positionals) => {
  const targetRaw = requireArg(positionals, 0, 'target');
  rejectExtra(positionals, 1);
  const target = await resolveShareTarget(ctx, targetRaw, flags);
  const extra = await resolveJsonBody(flagString(flags, 'body'));
  const expires = flagString(flags, 'expires');
  const body = mergeBody(
    {
      deviceId: target.deviceId,
      windowId: target.windowId,
      name: flagString(flags, 'name') ?? '',
      password: await readSharePassword(ctx, flags),
      expiresInMs: expires ? parseDurationMs(expires) : null,
      origin: flagString(flags, 'origin') ?? null,
    },
    extra
  );
  const result = await ctx.http.json(target.nodeId, 'POST', '/api/share', body);
  emit(ctx, result, () => ctx.out.data(result));
};

const ls: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json<{
    active?: Array<{ id: string; name: string; state: string; url: string; viewers: number }>;
    history?: Array<{ id: string; name: string; state: string }>;
  }>(nodeId, 'GET', '/api/share');
  emit(ctx, payload, () => {
    const rows = [...(payload.active ?? []), ...(payload.history ?? [])];
    ctx.out.table(rows, [
      { header: 'ID', value: (row) => shortId(row.id) },
      { header: 'NAME', value: (row) => row.name },
      { header: 'STATE', value: (row) => row.state },
      { header: 'URL', value: (row) => ('url' in row ? dash((row as { url?: string }).url) : '-') },
    ]);
  });
};

async function loadShare(
  ctx: CliContext,
  id: string
): Promise<{ nodeId: string; share: Record<string, unknown> }> {
  const nodeId = await ctx.targetNodeId();
  const list = await ctx.http.json<{
    active?: Array<Record<string, unknown> & { id: string }>;
    history?: Array<Record<string, unknown> & { id: string }>;
  }>(nodeId, 'GET', '/api/share');
  const share = [...(list.active ?? []), ...(list.history ?? [])].find((row) => row.id === id);
  if (!share) {
    throw new NotFoundError(`unknown share: ${id}`, 'run: vibeterm share ls');
  }
  return { nodeId, share };
}

const show: SubHandler = async (ctx, _flags, positionals) => {
  const id = requireArg(positionals, 0, 'id');
  rejectExtra(positionals, 1);
  const { share } = await loadShare(ctx, id);
  emit(ctx, share, () => ctx.out.data(share));
};

const password: SubHandler = async (ctx, flags, positionals) => {
  const id = requireArg(positionals, 0, 'id');
  rejectExtra(positionals, 1);
  const nodeId = await ctx.targetNodeId();
  const path = sharePath(id, '/password');
  const endSessions = flagBool(flags, 'end-sessions');
  const hasSecret =
    Boolean(flagString(flags, 'password')) ||
    flagBool(flags, 'password-stdin') ||
    Boolean(flagString(flags, 'password-file'));
  if (endSessions || hasSecret) {
    const value = await readSharePassword(ctx, flags);
    const result = await ctx.http.json(nodeId, 'POST', path, { password: value, endSessions });
    emit(ctx, result, () => ctx.out.data(result));
    return;
  }
  const result = await ctx.http.json(nodeId, 'GET', path);
  emit(ctx, result, () => ctx.out.data(result));
};

const revoke: SubHandler = async (ctx, _flags, positionals) => {
  const id = requireArg(positionals, 0, 'id');
  rejectExtra(positionals, 1);
  const nodeId = await ctx.targetNodeId();
  const result = await ctx.http.json(nodeId, 'POST', sharePath(id, '/revoke'));
  emit(ctx, result, () => ctx.out.data(result));
};

const rm: SubHandler = async (ctx, flags, positionals) => {
  const id = requireArg(positionals, 0, 'id');
  rejectExtra(positionals, 1);
  await confirmOrYes(flags, `delete share ${id}`);
  const nodeId = await ctx.targetNodeId();
  const result = await ctx.http.json(nodeId, 'DELETE', sharePath(id));
  emit(ctx, result, () => ctx.out.line(`deleted ${id}`));
};

const log: SubHandler = async (ctx, flags, positionals) => {
  const id = requireArg(positionals, 0, 'id');
  rejectExtra(positionals, 1);
  const params = new URLSearchParams();
  const after = flagNumber(flags, 'after');
  const limit = flagNumber(flags, 'limit');
  if (after !== undefined) params.set('after', String(after));
  if (limit !== undefined) params.set('limit', String(limit));
  const query = params.toString();
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json(
    nodeId,
    'GET',
    `${sharePath(id, '/log')}${query ? `?${query}` : ''}`
  );
  emit(ctx, payload, () => ctx.out.data(payload));
};

const settings: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'get|set');
  rejectExtra(positionals, 1);
  const nodeId = await ctx.targetNodeId();
  if (action === 'get') {
    const payload = await ctx.http.json(nodeId, 'GET', '/api/share/settings');
    emit(ctx, payload, () => ctx.out.data(payload));
    return;
  }
  if (action === 'set') {
    const body = requireObjectBody(
      await resolveJsonBody(flagString(flags, 'body')),
      'pass --body \'{"recordLogs":false}\''
    );
    const payload = await ctx.http.json(nodeId, 'PUT', '/api/share/settings', body);
    emit(ctx, payload, () => ctx.out.data(payload));
    return;
  }
  throw new UsageError(`unknown settings action: ${action}`, 'use get|set');
};

const origins: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json(nodeId, 'GET', '/api/share/origins');
  emit(ctx, payload, () => ctx.out.data(payload));
};

const HANDLERS: Record<string, SubHandler> = {
  create,
  ls,
  show,
  password,
  revoke,
  rm,
  log,
  settings,
  origins,
};

export const command: Command = {
  name: 'share',
  summary: 'manage terminal shares',
  usage: USAGE,
  flags: FLAGS,
  run: (ctx, argv) => runSubs(ctx, argv, FLAGS, HANDLERS, 'run: vibeterm share --help'),
};
