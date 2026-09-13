import { type SubHandler, confirmOrYes, mergeBody, rejectExtra, requireArg } from '../core/cmd';
import { UsageError } from '../core/errors';
import {
  llmDefaultBody,
  llmProviderBody,
  llmProviderModelsBody,
  llmSearchBody,
  optionalObjectBody,
  requiredObjectBody,
} from '../core/settings-body';
import { jsonSelf, print } from './settings-http';

export const llm: SubHandler = async (ctx, flags, positionals) => {
  const head = requireArg(positionals, 0, 'providers|get|set|default|search');
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
  if (head === 'default') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'PATCH', '/api/llm/settings', await llmDefaultBody(flags)));
    return;
  }
  if (head === 'search') {
    const action = requireArg(positionals, 1, 'set');
    if (action !== 'set') throw new UsageError(`unknown llm search action: ${action}`, 'use set');
    const provider = requireArg(positionals, 2, 'none|tavily|brave');
    rejectExtra(positionals, 3);
    print(
      ctx,
      await jsonSelf(ctx, 'PATCH', '/api/llm/settings', await llmSearchBody(ctx, flags, provider))
    );
    return;
  }
  if (head !== 'providers') {
    throw new UsageError(`unknown llm action: ${head}`, 'use providers|get|set|default|search');
  }
  await llmProviders(ctx, flags, positionals.slice(1));
};

async function llmProviders(
  ctx: Parameters<SubHandler>[0],
  flags: Parameters<SubHandler>[1],
  positionals: string[]
): Promise<void> {
  const action = requireArg(positionals, 0, 'ls|add|edit|rm|refresh-models|enable|disable|models');
  if (action === 'ls') {
    rejectExtra(positionals, 1);
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
  const id = requireArg(positionals, 1, 'provider id');
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
  if (action === 'enable' || action === 'disable') {
    rejectExtra(positionals, 2);
    print(
      ctx,
      await jsonSelf(
        ctx,
        'PATCH',
        `/api/llm/providers/${id}`,
        mergeBody({ enabled: action === 'enable' }, await optionalObjectBody(flags))
      )
    );
    return;
  }
  if (action === 'models') {
    rejectExtra(positionals, 2);
    print(
      ctx,
      await jsonSelf(ctx, 'PATCH', `/api/llm/providers/${id}`, await llmProviderModelsBody(flags))
    );
    return;
  }
  if (action === 'rm') {
    await confirmOrYes(flags, `delete llm provider ${id}`);
    print(ctx, await jsonSelf(ctx, 'DELETE', `/api/llm/providers/${id}`));
    return;
  }
  if (action === 'refresh-models') {
    rejectExtra(positionals, 2);
    print(ctx, await jsonSelf(ctx, 'POST', `/api/llm/providers/${id}/refresh-models`));
    return;
  }
  throw new UsageError(`unknown llm providers action: ${action}`);
}
