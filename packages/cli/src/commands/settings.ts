// `vibeterm settings`：站点、快捷键、通知、webhook、LLM、TLS、隧道、本机。

import { NODE_ID_PATTERN, SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { flagBool, flagString } from '../core/args';
import { fetchAuthMode } from '../core/auth';
import { type SubHandler, confirmOrYes, emit, rejectExtra, requireArg, runSubs } from '../core/cmd';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import { revokeNode } from '../core/nodes-keylog';
import {
  LAN_SPOOF_CONFIRM,
  LOCAL_DIRECT_ACTIONS,
  TUNNEL_ACTIONS,
  enabledFromFlags,
  llmProviderBody,
  optionalObjectBody,
  requiredObjectBody,
  sitePatch,
  tlsSetNeedsConfirm,
  tunnelActionBody,
  webhookCreateBody,
} from '../core/settings-body';
import type { Command } from './types';

const FLAGS = {
  yes: 'boolean',
  body: 'string',
  enabled: 'string',
  on: 'boolean',
  off: 'boolean',
  url: 'string',
  secret: 'string',
  'secret-stdin': 'boolean',
  'secret-file': 'string',
  events: 'string',
  name: 'string',
  protocol: 'string',
  'base-url': 'string',
  'api-key': 'string',
  'api-key-stdin': 'boolean',
  'api-key-file': 'string',
  'skip-self-revoke': 'boolean',
  hostname: 'string',
  version: 'string',
  'expected-role': 'string',
  'target-role': 'string',
  acknowledge: 'boolean',
  action: 'string',
  'auto-start': 'string',
  'trust-proxy': 'string',
} as const;

const USAGE = [
  'Usage: vibeterm settings <group> …',
  '',
  '  site get|set <key> <value>     GET/PATCH /api/settings/site',
  '  shortcuts get|set              GET/PATCH /api/settings/terminal-shortcuts (set needs --body)',
  '  restart [--yes]                POST /api/settings/restart',
  '  notifications mesh get|set on|off',
  '  webhooks ls|add|rm|edit        edit = rm+add with --body',
  '  llm providers ls|add|edit|rm|refresh-models',
  '  llm get|set                    GET/PATCH /api/llm/settings (set needs --body)',
  '  domain-access get|set on|off   GET/PATCH /api/system/domain-access',
  '  tls get|set|renew|ca           GET/PUT /api/tls, POST /api/tls/renew, GET /api/tls/ca.crt',
  '  tunnel status|<action>         GET /api/tunnel/status or POST /api/tunnel/actions',
  '  system info|addresses|upgrade status|start',
  '  local status|leave|direct      GET /api/local/status; POST /api/local/leave|direct',
  '',
  'Complex bodies accept --body <json>|@file like `vibeterm api`.',
  'Secrets: --secret-stdin/--secret-file/VIBETERM_WEBHOOK_SECRET, --api-key-stdin/--api-key-file/VIBETERM_LLM_API_KEY.',
  'argv --secret/--api-key warn on stderr. local leave self-revokes (VIBETERM_PASSWORD) unless --skip-self-revoke.',
  '--json prints the gateway payload unchanged.',
].join('\n');

async function jsonOn(
  ctx: CliContext,
  nodeId: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  return ctx.http.json(nodeId, method, path, body);
}

async function jsonSelf(
  ctx: CliContext,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  return jsonOn(ctx, await ctx.targetNodeId(), method, path, body);
}

async function jsonEntry(
  ctx: CliContext,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  return jsonOn(ctx, SELF_NODE_ID, method, path, body);
}

function print(ctx: CliContext, payload: unknown): void {
  emit(ctx, payload, () => ctx.out.data(payload));
}

const site: SubHandler = async (ctx, _flags, positionals) => {
  const action = requireArg(positionals, 0, 'get|set');
  if (action === 'get') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'GET', '/api/settings/site'));
    return;
  }
  if (action === 'set') {
    const key = requireArg(positionals, 1, 'key');
    const value = requireArg(positionals, 2, 'value');
    rejectExtra(positionals, 3);
    print(ctx, await jsonSelf(ctx, 'PATCH', '/api/settings/site', sitePatch(key, value)));
    return;
  }
  throw new UsageError(`unknown site action: ${action}`, 'use get|set');
};

const shortcuts: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'get|set');
  rejectExtra(positionals, 1);
  if (action === 'get') {
    print(ctx, await jsonSelf(ctx, 'GET', '/api/settings/terminal-shortcuts'));
    return;
  }
  if (action === 'set') {
    print(
      ctx,
      await jsonSelf(
        ctx,
        'PATCH',
        '/api/settings/terminal-shortcuts',
        await requiredObjectBody(flags, 'pass --body with { items, useIcons }')
      )
    );
    return;
  }
  throw new UsageError(`unknown shortcuts action: ${action}`, 'use get|set');
};

const restart: SubHandler = async (ctx, flags, positionals) => {
  rejectExtra(positionals, 0);
  await confirmOrYes(flags, 'restart the gateway');
  print(ctx, await jsonSelf(ctx, 'POST', '/api/settings/restart'));
};

const notifications: SubHandler = async (ctx, flags, positionals) => {
  const scope = requireArg(positionals, 0, 'mesh');
  if (scope !== 'mesh') throw new UsageError(`unknown notifications scope: ${scope}`, 'use mesh');
  const action = requireArg(positionals, 1, 'get|set');
  if (action === 'get') {
    rejectExtra(positionals, 2);
    print(ctx, await jsonSelf(ctx, 'GET', '/api/notifications/mesh'));
    return;
  }
  if (action === 'set') {
    const enabled = enabledFromFlags(flags, positionals[2]);
    print(ctx, await jsonSelf(ctx, 'PUT', '/api/notifications/mesh', { enabled }));
    return;
  }
  throw new UsageError(`unknown notifications action: ${action}`, 'use get|set');
};

const webhooks: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'ls|add|rm|edit');
  if (action === 'ls') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'GET', '/api/webhooks'));
    return;
  }
  if (action === 'add') {
    print(ctx, await jsonSelf(ctx, 'POST', '/api/webhooks', await webhookCreateBody(ctx, flags)));
    return;
  }
  if (action === 'rm') {
    const id = requireArg(positionals, 1, 'id');
    await confirmOrYes(flags, `delete webhook ${id}`);
    print(ctx, await jsonSelf(ctx, 'DELETE', `/api/webhooks/${id}`));
    return;
  }
  if (action === 'edit') {
    const id = requireArg(positionals, 1, 'id');
    const body = await webhookCreateBody(ctx, flags);
    await confirmOrYes(flags, `replace webhook ${id}`);
    await jsonSelf(ctx, 'DELETE', `/api/webhooks/${id}`);
    print(ctx, await jsonSelf(ctx, 'POST', '/api/webhooks', body));
    return;
  }
  throw new UsageError(`unknown webhooks action: ${action}`, 'use ls|add|rm|edit');
};

const llm: SubHandler = async (ctx, flags, positionals) => {
  const head = requireArg(positionals, 0, 'providers|get|set');
  if (head === 'get') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'GET', '/api/llm/settings'));
    return;
  }
  if (head === 'set') {
    print(
      ctx,
      await jsonSelf(
        ctx,
        'PATCH',
        '/api/llm/settings',
        await requiredObjectBody(flags, 'pass --body')
      )
    );
    return;
  }
  if (head !== 'providers')
    throw new UsageError(`unknown llm action: ${head}`, 'use providers|get|set');
  const action = requireArg(positionals, 1, 'ls|add|edit|rm|refresh-models');
  if (action === 'ls') {
    print(ctx, await jsonSelf(ctx, 'GET', '/api/llm/providers'));
    return;
  }
  if (action === 'add') {
    print(
      ctx,
      await jsonSelf(ctx, 'POST', '/api/llm/providers', await llmProviderBody(ctx, flags, true))
    );
    return;
  }
  const id = requireArg(positionals, 2, 'provider id');
  if (action === 'edit') {
    print(
      ctx,
      await jsonSelf(
        ctx,
        'PATCH',
        `/api/llm/providers/${id}`,
        await llmProviderBody(ctx, flags, false)
      )
    );
    return;
  }
  if (action === 'rm') {
    await confirmOrYes(flags, `delete llm provider ${id}`);
    print(ctx, await jsonSelf(ctx, 'DELETE', `/api/llm/providers/${id}`));
    return;
  }
  if (action === 'refresh-models') {
    print(ctx, await jsonSelf(ctx, 'POST', `/api/llm/providers/${id}/refresh-models`));
    return;
  }
  throw new UsageError(`unknown llm providers action: ${action}`);
};

const domainAccess: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'get|set');
  if (action === 'get') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'GET', '/api/system/domain-access'));
    return;
  }
  if (action === 'set') {
    print(
      ctx,
      await jsonSelf(ctx, 'PATCH', '/api/system/domain-access', {
        allowed: enabledFromFlags(flags, positionals[1]),
      })
    );
    return;
  }
  throw new UsageError(`unknown domain-access action: ${action}`, 'use get|set');
};

const tls: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'get|set|renew|ca');
  rejectExtra(positionals, 1);
  if (action === 'get') {
    print(ctx, await jsonEntry(ctx, 'GET', '/api/tls'));
    return;
  }
  if (action === 'set') {
    const body = await requiredObjectBody(flags, 'pass --body');
    if (tlsSetNeedsConfirm(body)) await confirmOrYes(flags, LAN_SPOOF_CONFIRM);
    print(ctx, await jsonEntry(ctx, 'PUT', '/api/tls', body));
    return;
  }
  if (action === 'renew') {
    print(ctx, await jsonEntry(ctx, 'POST', '/api/tls/renew'));
    return;
  }
  if (action === 'ca') {
    const bytes = await ctx.http.bytes(SELF_NODE_ID, '/api/tls/ca.crt');
    if (ctx.globals.json) ctx.out.data({ pem: new TextDecoder().decode(bytes) });
    else ctx.out.raw(bytes);
    return;
  }
  throw new UsageError(`unknown tls action: ${action}`, 'use get|set|renew|ca');
};

const tunnel: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'status or an action name');
  if (action === 'status') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonEntry(ctx, 'GET', '/api/tunnel/status'));
    return;
  }
  if (!(TUNNEL_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(
      `unknown tunnel action: ${action}`,
      `use status or ${TUNNEL_ACTIONS.join('|')}`
    );
  }
  const body = await tunnelActionBody(action, flags);
  if (body.trustProxy === true) await confirmOrYes(flags, LAN_SPOOF_CONFIRM);
  print(ctx, await jsonEntry(ctx, 'POST', '/api/tunnel/actions', body));
};

const system: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'info|addresses|upgrade');
  if (action === 'info') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'GET', '/api/system/info'));
    return;
  }
  if (action === 'addresses') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'GET', '/api/system/addresses'));
    return;
  }
  if (action !== 'upgrade') throw new UsageError(`unknown system action: ${action}`);
  const sub = requireArg(positionals, 1, 'status|start');
  if (sub === 'status') {
    print(ctx, await jsonSelf(ctx, 'GET', '/api/system/upgrade'));
    return;
  }
  if (sub === 'start') {
    const version = flagString(flags, 'version');
    const extra = await optionalObjectBody(flags);
    const body = { ...(version ? { version } : {}), ...(extra ?? {}) };
    if (typeof body.version !== 'string') {
      throw new UsageError('upgrade start requires --version or --body {"version":"…"}');
    }
    print(ctx, await jsonSelf(ctx, 'POST', '/api/system/upgrade', body));
    return;
  }
  throw new UsageError(`unknown upgrade action: ${sub}`, 'use status|start');
};

const local: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'status|leave|direct');
  if (action === 'status') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonEntry(ctx, 'GET', '/api/local/status'));
    return;
  }
  if (action === 'leave') {
    await confirmOrYes(flags, 'leave the mesh');
    const extra = await optionalObjectBody(flags);
    const expectedRole = flagString(flags, 'expected-role');
    const targetRole = flagString(flags, 'target-role');
    const body = {
      ...(expectedRole ? { expectedRole } : {}),
      ...(targetRole ? { targetRole } : {}),
      ...(extra ?? {}),
    };
    if (!body.expectedRole) {
      throw new UsageError('local leave requires --expected-role (or --body)');
    }
    await maybeSelfRevokeBeforeLeave(ctx, flags);
    print(ctx, await jsonEntry(ctx, 'POST', '/api/local/leave', body));
    return;
  }
  if (action === 'direct') {
    const direct = flagString(flags, 'action') ?? positionals[1];
    if (!direct || !LOCAL_DIRECT_ACTIONS.has(direct)) {
      throw new UsageError('local direct requires install|remove|enable|disable');
    }
    print(ctx, await jsonEntry(ctx, 'POST', '/api/local/direct', { action: direct }));
    return;
  }
  throw new UsageError(`unknown local action: ${action}`, 'use status|leave|direct');
};

async function maybeSelfRevokeBeforeLeave(
  ctx: CliContext,
  flags: Parameters<SubHandler>[1]
): Promise<void> {
  if (flagBool(flags, 'skip-self-revoke')) {
    ctx.out.warn(
      'leaving the mesh without a self-revoke; this node stays enrolled on the hub until an admin revokes it'
    );
    return;
  }
  if (!process.env.VIBETERM_PASSWORD) {
    throw new UsageError(
      'local leave signs a self-revoke first and VIBETERM_PASSWORD is not set',
      "set VIBETERM_PASSWORD, or pass --skip-self-revoke (the hub will keep this node's cert)"
    );
  }
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  const nodeId = mode?.nodeId;
  if (!nodeId || !NODE_ID_PATTERN.test(nodeId)) {
    ctx.out.warn('could not determine this node id; skipping self-revoke');
    return;
  }
  try {
    await revokeNode(ctx, nodeId, 'leave-hub');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.out.warn(`self-revoke failed (${message}); continuing with leave`);
  }
}

const HANDLERS: Record<string, SubHandler> = {
  site,
  shortcuts,
  restart,
  notifications,
  webhooks,
  llm,
  'domain-access': domainAccess,
  tls,
  tunnel,
  system,
  local,
};

export const command: Command = {
  name: 'settings',
  summary: 'read and write site settings',
  usage: USAGE,
  flags: FLAGS,
  run: (ctx, argv) => runSubs(ctx, argv, FLAGS, HANDLERS, 'run: vibeterm settings --help'),
};
