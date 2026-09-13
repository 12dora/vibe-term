import { NODE_ID_PATTERN, SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { flagBool, flagString } from '../core/args';
import { fetchAuthMode } from '../core/auth';
import { type SubHandler, confirmOrYes, rejectExtra, requireArg } from '../core/cmd';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import { revokeNode } from '../core/nodes-keylog';
import {
  LAN_SPOOF_CONFIRM,
  LOCAL_DIRECT_ACTIONS,
  TUNNEL_ACTIONS,
  optionalObjectBody,
  requiredObjectBody,
  tlsSetNeedsConfirm,
  tunnelActionBody,
} from '../core/settings-body';
import { jsonEntry, jsonSelf, print } from './settings-http';

export const tls: SubHandler = async (ctx, flags, positionals) => {
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

export const tunnel: SubHandler = async (ctx, flags, positionals) => {
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

export const system: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'info|addresses|update-check|upgrade');
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
  if (action === 'update-check') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'GET', '/api/system/update-check'));
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

export const local: SubHandler = async (ctx, flags, positionals) => {
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
    print(ctx, await jsonSelf(ctx, 'POST', '/api/local/direct', { action: direct }));
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
