// `vibeterm settings mesh route-mode get|set`：读写本机选路模式。

import { isMeshRouteMode } from '@vibeterm/shared/net';
import { type SubHandler, rejectExtra, requireArg } from '../core/cmd';
import { UsageError } from '../core/errors';
import { jsonSelf, print } from './settings-http';

export const mesh: SubHandler = async (ctx, _flags, positionals) => {
  const scope = requireArg(positionals, 0, 'route-mode');
  if (scope !== 'route-mode') {
    throw new UsageError(`unknown mesh setting: ${scope}`, 'use route-mode');
  }
  const action = requireArg(positionals, 1, 'get|set');
  if (action === 'get') {
    rejectExtra(positionals, 2);
    print(ctx, await jsonSelf(ctx, 'GET', '/api/settings/mesh-route'));
    return;
  }
  if (action === 'set') {
    const mode = requireArg(positionals, 2, 'auto|direct|relay');
    if (!isMeshRouteMode(mode)) {
      throw new UsageError(`invalid route mode: ${mode}`, 'use auto|direct|relay');
    }
    rejectExtra(positionals, 3);
    print(ctx, await jsonSelf(ctx, 'PUT', '/api/settings/mesh-route', { mode }));
    return;
  }
  throw new UsageError(`unknown route-mode action: ${action}`, 'use get|set');
};
