import {
  type CommandInvocation,
  type CommandResult,
  parseCommand,
  resolveNodeTarget,
} from '@tmex/shared/messaging';
import { authorizeMessagingActor } from './authorize';
import { type CommandContext, errorResult } from './context';
import type { CommandHandler } from './handlers/types';

export type DispatchOutcome = { silent: true } | { silent: false; result: CommandResult };

const handlers = new Map<string, CommandHandler>();

export function registerCommandHandler(name: string, handler: CommandHandler): void {
  handlers.set(name.toLowerCase(), handler);
}

function unknownCommand(ctx: CommandContext): CommandResult {
  return {
    ...errorResult(ctx, 'messaging.error.unknownCommand'),
    actions: [{ label: ctx.t('messaging.help.title'), command: 'help' }],
  };
}

function nodeTargetError(
  ctx: CommandContext,
  resolved: Exclude<ReturnType<typeof resolveNodeTarget>, { ok: true }>
): CommandResult {
  const candidates = (resolved.candidates ?? []).map((node) => node.name || node.id).join(', ');
  if (resolved.error === 'ambiguous') {
    return errorResult(ctx, 'messaging.error.nodeAmbiguous', {
      input: resolved.input,
      candidates,
    });
  }
  if (resolved.error === 'offline') {
    return errorResult(ctx, 'messaging.error.nodeOffline', { input: resolved.input });
  }
  return errorResult(ctx, 'messaging.error.nodeUnknown', { input: resolved.input });
}

async function executeLocal(
  invocation: CommandInvocation,
  ctx: CommandContext
): Promise<CommandResult> {
  const spec = ctx.registry.find(invocation.command);
  if (!spec) return unknownCommand(ctx);
  const handler = handlers.get(spec.name);
  if (!handler) return unknownCommand(ctx);
  return handler(invocation, ctx);
}

export async function dispatchCommand(
  invocation: CommandInvocation,
  ctx: CommandContext
): Promise<DispatchOutcome> {
  const auth = authorizeMessagingActor(invocation.actor);
  if (!auth.ok) return { silent: true };

  const lookupNodes = ctx.listNodes().map((node) => ({
    id: node.id,
    name: node.name,
    online: node.online,
  }));
  const localNodeId = ctx.localNodeId ?? 'local';
  const resolved = resolveNodeTarget(invocation.nodeTarget, {
    localNodeId,
    localName: ctx.localName,
    nodes: lookupNodes,
  });
  if (!resolved.ok) {
    return { silent: false, result: nodeTargetError(ctx, resolved) };
  }
  if (!resolved.local) {
    void ctx.remoteExecutor;
    return {
      silent: false,
      result: errorResult(ctx, 'messaging.error.remoteNodeUnsupported'),
    };
  }
  return { silent: false, result: await executeLocal(invocation, ctx) };
}

export async function dispatchInboundText(
  rawText: string,
  invocationBase: Omit<CommandInvocation, 'command' | 'args' | 'rawText' | 'nodeTarget' | 'tail'>,
  ctx: CommandContext
): Promise<DispatchOutcome> {
  const parsed = parseCommand(rawText);
  if (!parsed.ok) {
    const auth = authorizeMessagingActor(invocationBase.actor);
    if (!auth.ok) return { silent: true };
    return { silent: false, result: unknownCommand(ctx) };
  }
  const invocation: CommandInvocation = {
    ...invocationBase,
    command: parsed.name,
    args: parsed.args,
    rawText,
    nodeTarget: parsed.nodeTarget,
    tail: parsed.tail,
  };
  return dispatchCommand(invocation, ctx);
}
