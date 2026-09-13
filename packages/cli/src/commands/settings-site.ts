import { NODE_ID_PATTERN } from '@vibeterm/api-client/node-url';
import { buildNotificationSinkPayload, hexToBytes } from '@vibeterm/shared/auth';
import { type SubHandler, confirmOrYes, rejectExtra, requireArg } from '../core/cmd';
import type { CliContext } from '../core/context';
import { CliError, UsageError } from '../core/errors';
import {
  appendKeyLog,
  assertKeyLogAppended,
  keyLogHead,
  signRecord,
  withRootKey,
} from '../core/nodes-keylog';
import { enabledFromFlags, sitePatch, webhookCreateBody } from '../core/settings-body';
import { jsonSelf, print } from './settings-http';

export const site: SubHandler = async (ctx, _flags, positionals) => {
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

export const restart: SubHandler = async (ctx, flags, positionals) => {
  rejectExtra(positionals, 0);
  await confirmOrYes(flags, 'restart the gateway');
  print(ctx, await jsonSelf(ctx, 'POST', '/api/settings/restart'));
};

async function signNotificationSink(ctx: CliContext, enabled: boolean): Promise<void> {
  const target = await ctx.targetNodeId();
  await withRootKey(ctx, async (root, mode) => {
    const nodeIdHex = NODE_ID_PATTERN.test(target) ? target : (mode.nodeId ?? '');
    if (!NODE_ID_PATTERN.test(nodeIdHex)) {
      throw new CliError(
        'could not determine this node id to sign notification-sink',
        1,
        'the entry did not advertise a hex node id'
      );
    }
    const head = await keyLogHead(ctx);
    const signed = signRecord(
      root,
      head,
      mode,
      'notification-sink',
      buildNotificationSinkPayload({
        nodeId: hexToBytes(nodeIdHex),
        enabled,
        at: Date.now(),
      })
    );
    const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
    assertKeyLogAppended(result, 'notification-sink');
  });
}

export const notifications: SubHandler = async (ctx, flags, positionals) => {
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
    await signNotificationSink(ctx, enabled);
    print(ctx, await jsonSelf(ctx, 'PUT', '/api/notifications/mesh', { enabled }));
    return;
  }
  throw new UsageError(`unknown notifications action: ${action}`, 'use get|set');
};

export const webhooks: SubHandler = async (ctx, flags, positionals) => {
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

export const domainAccess: SubHandler = async (ctx, flags, positionals) => {
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
