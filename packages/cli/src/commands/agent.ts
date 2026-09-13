// `vibeterm agent`：AI agent 会话，对齐 GUI 与 `packages/api-client/src/agent.ts`。

import type {
  AgentMessageDto,
  AgentQueuedMessageDto,
  AgentSessionDto,
  AgentWriteMode,
} from '@vibeterm/shared';
import { flagBool, flagString } from '../core/args';
import {
  type SubHandler,
  confirmOrYes,
  emit,
  parseOnOff,
  rejectExtra,
  requireArg,
  runSubs,
} from '../core/cmd';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import { readAllStdin } from '../core/prompt';
import { printQueued, printSessionDetail, printSessionRows } from './agent-format';
import type { Command } from './types';

const DEFAULT_WRITE_MODE: AgentWriteMode = 'confirm';

const FLAGS = {
  device: 'string',
  pane: 'string',
  provider: 'string',
  model: 'string',
  'write-mode': 'string',
  title: 'string',
  yes: 'boolean',
  stdin: 'boolean',
  reason: 'string',
  'allow-control-chars': 'string',
} as const;

const USAGE = [
  'Usage: vibeterm agent <subcommand>',
  '',
  'Subcommands:',
  '  ls [--node]',
  '  show <id>',
  '  new --device <id> --pane <id> [--provider --model --write-mode confirm|auto] [--title]',
  '  rm <id> [--yes]',
  '  rename <id> <title>',
  '  send <id> [--stdin] "<text>"',
  '  steer <id> "<text>"',
  '  queue ls <session>',
  '  queue edit <session> <item> [--stdin] "<text>"',
  '  queue rm <session> <item>',
  '  stop <id>',
  '  confirm <id> approve|deny [--reason]',
  '  model <id> --provider <p> --model <m>',
  '  set <id> --write-mode <mode> | --allow-control-chars on|off',
  '',
  '--node (global) selects the gateway that stores the session (default: entry).',
  '--json: { sessions } / { session, messages } / { session } / { message|queued } / { queued }',
].join('\n');

function sessionPath(id: string, suffix = ''): string {
  return `/api/agent/sessions/${encodeURIComponent(id)}${suffix}`;
}

function queueItemPath(id: string): string {
  return `/api/agent/queue/${encodeURIComponent(id)}`;
}

function parseWriteMode(raw: string): AgentWriteMode {
  if (raw === 'confirm' || raw === 'auto') return raw;
  throw new UsageError(`invalid write mode: ${raw}`, 'use confirm|auto');
}

async function readText(
  flags: Parameters<SubHandler>[1],
  positionals: readonly string[],
  index: number,
  label: string
): Promise<{ text: string; consumed: number }> {
  if (flagBool(flags, 'stdin')) {
    const text = await readAllStdin();
    if (!text.trim()) throw new UsageError(`${label} is empty`);
    return { text, consumed: index };
  }
  const text = requireArg(positionals, index, label);
  if (!text.trim()) throw new UsageError(`${label} is empty`);
  return { text, consumed: index + 1 };
}

const ls: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json<{ sessions?: AgentSessionDto[] }>(
    nodeId,
    'GET',
    '/api/agent/sessions'
  );
  const sessions = payload.sessions ?? [];
  emit(ctx, payload, () => printSessionRows(ctx, sessions));
};

const show: SubHandler = async (ctx, _flags, positionals) => {
  const id = requireArg(positionals, 0, 'session id');
  rejectExtra(positionals, 1);
  const nodeId = await ctx.targetNodeId();
  const sessionPayload = await ctx.http.json<{ session: AgentSessionDto }>(
    nodeId,
    'GET',
    sessionPath(id)
  );
  const messagesPayload = await ctx.http.json<{ messages?: AgentMessageDto[] }>(
    nodeId,
    'GET',
    sessionPath(id, '/messages')
  );
  const session = sessionPayload.session;
  const messages = messagesPayload.messages ?? [];
  emit(ctx, { session, messages }, () => printSessionDetail(ctx, session, messages));
};

const create: SubHandler = async (ctx, flags, positionals) => {
  rejectExtra(positionals, 0);
  const deviceId = flagString(flags, 'device');
  const paneId = flagString(flags, 'pane');
  if (!deviceId || !paneId) throw new UsageError('new requires --device and --pane');
  const writeModeRaw = flagString(flags, 'write-mode');
  const body: Record<string, unknown> = {
    deviceId,
    paneId,
    writeMode: writeModeRaw ? parseWriteMode(writeModeRaw) : DEFAULT_WRITE_MODE,
  };
  const providerId = flagString(flags, 'provider');
  const modelId = flagString(flags, 'model');
  if (providerId !== undefined) body.providerId = providerId;
  if (modelId !== undefined) body.modelId = modelId;
  const nodeId = await ctx.targetNodeId();
  let payload = await ctx.http.json<{ session: { id: string; title: string } }>(
    nodeId,
    'POST',
    '/api/agent/sessions',
    body
  );
  const title = flagString(flags, 'title');
  if (title) {
    payload = await ctx.http.json(nodeId, 'PATCH', sessionPath(payload.session.id), { title });
  }
  emit(ctx, payload, () => ctx.out.line(`created ${payload.session.id}  ${payload.session.title}`));
};

const rm: SubHandler = async (ctx, flags, positionals) => {
  const id = requireArg(positionals, 0, 'session id');
  rejectExtra(positionals, 1);
  await confirmOrYes(flags, `delete agent session ${id}`);
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json(nodeId, 'DELETE', sessionPath(id));
  emit(ctx, payload, () => ctx.out.line(`deleted ${id}`));
};

const rename: SubHandler = async (ctx, _flags, positionals) => {
  const id = requireArg(positionals, 0, 'session id');
  const title = requireArg(positionals, 1, 'title');
  rejectExtra(positionals, 2);
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json(nodeId, 'PATCH', sessionPath(id), { title });
  emit(ctx, payload, () => ctx.out.line(`renamed ${id}`));
};

const send: SubHandler = async (ctx, flags, positionals) => {
  const id = requireArg(positionals, 0, 'session id');
  const { text, consumed } = await readText(flags, positionals, 1, 'text');
  rejectExtra(positionals, consumed);
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json<{ message?: { seq: number }; queued?: { id: string } }>(
    nodeId,
    'POST',
    sessionPath(id, '/messages'),
    { text }
  );
  emit(ctx, payload, () => {
    if (payload.queued) ctx.out.line(`queued ${payload.queued.id}`);
    else if (payload.message) ctx.out.line(`sent seq ${payload.message.seq}`);
    else ctx.out.line(`sent ${id}`);
  });
};

const steer: SubHandler = async (ctx, flags, positionals) => {
  const id = requireArg(positionals, 0, 'session id');
  const { text, consumed } = await readText(flags, positionals, 1, 'text');
  rejectExtra(positionals, consumed);
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json(nodeId, 'POST', sessionPath(id, '/queue'), {
    text,
    steer: true,
  });
  emit(ctx, payload, () => ctx.out.line(`steered ${id}`));
};

const queue: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'queue action');
  const rest = positionals.slice(1);
  const nodeId = await ctx.targetNodeId();
  if (action === 'ls') {
    const sessionId = requireArg(rest, 0, 'session id');
    rejectExtra(rest, 1);
    const payload = await ctx.http.json<{ queued?: AgentQueuedMessageDto[] }>(
      nodeId,
      'GET',
      sessionPath(sessionId, '/queue')
    );
    emit(ctx, payload, () => printQueued(ctx, payload.queued ?? []));
    return;
  }
  if (action === 'edit') {
    requireArg(rest, 0, 'session id');
    const itemId = requireArg(rest, 1, 'queue item id');
    const { text, consumed } = await readText(flags, rest, 2, 'text');
    rejectExtra(rest, consumed);
    const payload = await ctx.http.json(nodeId, 'PATCH', queueItemPath(itemId), { text });
    emit(ctx, payload, () => ctx.out.line(`updated ${itemId}`));
    return;
  }
  if (action === 'rm') {
    requireArg(rest, 0, 'session id');
    const itemId = requireArg(rest, 1, 'queue item id');
    rejectExtra(rest, 2);
    const payload = await ctx.http.json(nodeId, 'DELETE', queueItemPath(itemId));
    emit(ctx, payload, () => ctx.out.line(`withdrawn ${itemId}`));
    return;
  }
  throw new UsageError(`unknown queue action: ${action}`, 'use ls|edit|rm');
};

const stop: SubHandler = async (ctx, _flags, positionals) => {
  const id = requireArg(positionals, 0, 'session id');
  rejectExtra(positionals, 1);
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json(nodeId, 'POST', sessionPath(id, '/stop'));
  emit(ctx, payload, () => ctx.out.line(`stopped ${id}`));
};

const confirm: SubHandler = async (ctx, flags, positionals) => {
  const id = requireArg(positionals, 0, 'confirmation id');
  const decision = requireArg(positionals, 1, 'approve|deny');
  rejectExtra(positionals, 2);
  if (decision !== 'approve' && decision !== 'deny') {
    throw new UsageError(`expected approve|deny, got ${decision}`);
  }
  const approved = decision === 'approve';
  const reason = flagString(flags, 'reason');
  const body: Record<string, unknown> = { approved };
  if (reason !== undefined) body.reason = reason;
  const nodeId = await ctx.targetNodeId();
  const path = `/api/agent/confirmations/${encodeURIComponent(id)}/decide`;
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  const res = await ctx.http.fetch(nodeId, path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    emit(ctx, { result: 'conflict' }, () => ctx.out.line('already decided'));
    return;
  }
  await ctx.http.assertOk(nodeId, res, path);
  const payload = (await res.json()) as unknown;
  emit(ctx, payload, () => ctx.out.line(approved ? 'approved' : 'denied'));
};

const model: SubHandler = async (ctx, flags, positionals) => {
  const id = requireArg(positionals, 0, 'session id');
  rejectExtra(positionals, 1);
  const providerId = flagString(flags, 'provider');
  const modelId = flagString(flags, 'model');
  if (providerId === undefined || modelId === undefined) {
    throw new UsageError('model requires --provider and --model');
  }
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json(nodeId, 'PATCH', sessionPath(id), { providerId, modelId });
  emit(ctx, payload, () => ctx.out.line(`model ${id}  ${providerId}/${modelId}`));
};

const set: SubHandler = async (ctx, flags, positionals) => {
  const id = requireArg(positionals, 0, 'session id');
  rejectExtra(positionals, 1);
  const writeModeRaw = flagString(flags, 'write-mode');
  const allowRaw = flagString(flags, 'allow-control-chars');
  if (writeModeRaw === undefined && allowRaw === undefined) {
    throw new UsageError('set requires --write-mode or --allow-control-chars');
  }
  const patch: Record<string, unknown> = {};
  if (writeModeRaw !== undefined) patch.writeMode = parseWriteMode(writeModeRaw);
  if (allowRaw !== undefined) patch.allowControlChars = parseOnOff(allowRaw);
  const nodeId = await ctx.targetNodeId();
  const payload = await ctx.http.json(nodeId, 'PATCH', sessionPath(id), patch);
  emit(ctx, payload, () => ctx.out.line(`updated ${id}`));
};

const HANDLERS: Record<string, SubHandler> = {
  ls,
  show,
  new: create,
  rm,
  rename,
  send,
  steer,
  queue,
  stop,
  confirm,
  model,
  set,
};

export const command: Command = {
  name: 'agent',
  summary: 'manage AI agent sessions',
  usage: USAGE,
  flags: FLAGS,
  run: (ctx, argv) => runSubs(ctx, argv, FLAGS, HANDLERS, 'run: vibeterm agent --help'),
};
