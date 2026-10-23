// `vibeterm settings mesh route-mode|proxy get|set`：读写本机选路模式与出站代理。

import { isMeshProxyMode, isMeshRouteMode } from '@vibeterm/shared/net';
import { type SubHandler, rejectExtra, requireArg } from '../core/cmd';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import { jsonSelf, print } from './settings-http';

export const mesh: SubHandler = async (ctx, _flags, positionals) => {
  const scope = requireArg(positionals, 0, 'route-mode|proxy');
  if (scope === 'route-mode') {
    await meshGetSet(ctx, positionals.slice(1), {
      path: '/api/settings/mesh-route',
      values: 'auto|direct|relay',
      field: 'mode',
      check: (value) => isMeshRouteMode(value),
      invalid: 'invalid route mode',
    });
    return;
  }
  if (scope === 'proxy') {
    await meshGetSet(ctx, positionals.slice(1), {
      path: '/api/settings/mesh-proxy',
      values: 'direct|system',
      field: 'meshProxy',
      check: (value) => isMeshProxyMode(value),
      invalid: 'invalid mesh proxy',
    });
    return;
  }
  throw new UsageError(`unknown mesh setting: ${scope}`, 'use route-mode|proxy');
};

type MeshGetSetSpec = {
  path: string;
  values: string;
  field: string;
  check: (value: string) => boolean;
  invalid: string;
};

async function meshGetSet(
  ctx: CliContext,
  positionals: string[],
  spec: MeshGetSetSpec
): Promise<void> {
  const action = requireArg(positionals, 0, 'get|set');
  if (action === 'get') {
    rejectExtra(positionals, 1);
    print(ctx, await jsonSelf(ctx, 'GET', spec.path));
    return;
  }
  if (action === 'set') {
    const value = requireArg(positionals, 1, spec.values);
    if (!spec.check(value)) {
      throw new UsageError(`${spec.invalid}: ${value}`, `use ${spec.values}`);
    }
    rejectExtra(positionals, 2);
    print(ctx, await jsonSelf(ctx, 'PUT', spec.path, { [spec.field]: value }));
    return;
  }
  throw new UsageError(`unknown action: ${action}`, 'use get|set');
}
