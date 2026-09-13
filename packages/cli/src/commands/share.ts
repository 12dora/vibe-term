// `vibeterm share`：终端分享。

import { generateSharePassword } from '@vibeterm/shared/share';
import { flagBool, flagNumber, flagString } from '../core/args';
import {
  type SubHandler,
  confirmOrYes,
  dash,
  emit,
  mergeBody,
  parseDurationMs,
  parseOnOff,
  readSecretField,
  rejectExtra,
  requireArg,
  resolveJsonBody,
  runSubs,
  shortId,
} from '../core/cmd';
import type { CliContext } from '../core/context';
import { NotFoundError, UsageError } from '../core/errors';
import { resolveShareOrigin, resolveShareTarget, sharePath } from '../core/share-target';
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
  'record-logs': 'string',
  'retention-days': 'number',
  'log-max-mb': 'number',
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
  '  rm <id> [--yes]                        DELETE (ended shares only; non-TTY requires --yes)',
  '  log <id> [--after N] [--limit N]',
  '  settings get|set                       GET/PUT /api/share/settings',
  '    set: --record-logs on|off --retention-days N --log-max-mb N --origin auto|<url> [--body]',
  '  origins                                GET /api/share/origins',
  '',
  'create target: [<node>/]<device>:<window>  window is a tmux id (@1), index, or name.',
  'The device is connected first so the session tree is warm; names resolve to @id.',
  '--window-id @N overrides the window token. --origin defaults to GET /api/share/origins',
  '(recommended if it is a candidate, else the first candidate) and is printed on stderr.',
  'Password is optional (generated like the GUI). Or --password-stdin / --password-file /',
  '@file / VIBETERM_SHARE_PASSWORD (--password on argv warns).',
  '--json: { share, password } / { active, history } / ShareRecord / ShareLogPage / ShareSettings',
].join('\n');

async function readSharePassword(
  ctx: CliContext,
  flags: Parameters<SubHandler>[1],
  required: boolean
): Promise<string | undefined> {
  return readSecretField(ctx, flags, {
    flag: 'password',
    envName: 'VIBETERM_SHARE_PASSWORD',
    required,
    prompt: 'Share password: ',
  });
}

const create: SubHandler = async (ctx, flags, positionals) => {
  const targetRaw = requireArg(positionals, 0, 'target');
  rejectExtra(positionals, 1);
  const target = await resolveShareTarget(ctx, targetRaw, flags);
  try {
    const extra = await resolveJsonBody(flagString(flags, 'body'));
    const expires = flagString(flags, 'expires');
    const origin = await resolveShareOrigin(ctx, target.nodeId, flags);
    const password = (await readSharePassword(ctx, flags, false)) ?? generateSharePassword();
    const body = mergeBody(
      {
        deviceId: target.deviceId,
        windowId: target.windowId,
        name: flagString(flags, 'name') ?? '',
        password,
        expiresInMs: expires ? parseDurationMs(expires) : null,
        origin,
      },
      extra
    );
    const result = await ctx.http.json(target.nodeId, 'POST', '/api/share', body);
    emit(ctx, result, () => ctx.out.data(result));
  } finally {
    target.close();
  }
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
    const value = await readSharePassword(ctx, flags, true);
    if (!value) throw new UsageError('missing password');
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

const SHARE_RETENTION_DAYS_MAX = 3650;
const SHARE_LOG_MB_MAX = 1024;
const MB = 1024 * 1024;

function pickShareSettings(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    recordLogs: raw.recordLogs,
    logRetentionDays: raw.logRetentionDays,
    logMaxBytes: raw.logMaxBytes,
    defaultOrigin: raw.defaultOrigin ?? null,
  };
}

/** 与 GUI `parseShareSettingsDraft` 一致：`auto` → null，URL 收敛成 origin。 */
function parseShareDefaultOrigin(raw: string): string | null {
  if (raw.trim().toLowerCase() === 'auto') return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new UsageError(`invalid --origin: ${raw}`, 'use auto or an http(s) URL');
    }
    return url.origin;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`invalid --origin: ${raw}`, 'use auto or an http(s) URL');
  }
}

function shareSettingsFlagPatch(flags: Parameters<SubHandler>[1]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const recordLogs = flagString(flags, 'record-logs');
  if (recordLogs !== undefined) patch.recordLogs = parseOnOff(recordLogs);
  const retention = flagNumber(flags, 'retention-days');
  if (retention !== undefined) {
    if (!Number.isInteger(retention) || retention < 0 || retention > SHARE_RETENTION_DAYS_MAX) {
      throw new UsageError(`--retention-days must be an integer 0-${SHARE_RETENTION_DAYS_MAX}`);
    }
    patch.logRetentionDays = retention;
  }
  const logMaxMb = flagNumber(flags, 'log-max-mb');
  if (logMaxMb !== undefined) {
    if (!Number.isInteger(logMaxMb) || logMaxMb < 1 || logMaxMb > SHARE_LOG_MB_MAX) {
      throw new UsageError(`--log-max-mb must be an integer 1-${SHARE_LOG_MB_MAX}`);
    }
    patch.logMaxBytes = logMaxMb * MB;
  }
  const origin = flagString(flags, 'origin');
  if (origin !== undefined) patch.defaultOrigin = parseShareDefaultOrigin(origin);
  return patch;
}

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
    const patch = shareSettingsFlagPatch(flags);
    const extra = await resolveJsonBody(flagString(flags, 'body'));
    if (Object.keys(patch).length === 0 && extra === undefined) {
      throw new UsageError(
        'settings set requires flags or --body',
        'pass --record-logs, --retention-days, --log-max-mb, --origin, or --body'
      );
    }
    const current = await ctx.http.json<Record<string, unknown>>(
      nodeId,
      'GET',
      '/api/share/settings'
    );
    const body = mergeBody(mergeBody(pickShareSettings(current), patch), extra);
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
