import { type SubHandler, confirmOrYes, rejectExtra, requireArg } from '../core/cmd';
import { UsageError } from '../core/errors';
import {
  enabledFromFlags,
  llmProviderBody,
  requiredObjectBody,
  sitePatch,
  webhookCreateBody,
} from '../core/settings-body';
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

export const shortcuts: SubHandler = async (ctx, flags, positionals) => {
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

export const restart: SubHandler = async (ctx, flags, positionals) => {
  rejectExtra(positionals, 0);
  await confirmOrYes(flags, 'restart the gateway');
  print(ctx, await jsonSelf(ctx, 'POST', '/api/settings/restart'));
};

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

export const llm: SubHandler = async (ctx, flags, positionals) => {
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
  if (head !== 'providers') {
    throw new UsageError(`unknown llm action: ${head}`, 'use providers|get|set');
  }
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
