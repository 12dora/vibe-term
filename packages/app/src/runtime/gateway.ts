import { handleSystemApiRequest } from '../../../../apps/gateway/src/api/system';
import { createGatewayRuntime } from '../../../../apps/gateway/src/runtime';
import type { RuntimeMode } from './mode';

type GatewayRuntimeFactory = typeof createGatewayRuntime;

export function createTmexGatewayRuntime(
  factory: GatewayRuntimeFactory = createGatewayRuntime,
  extras?: { mode?: RuntimeMode }
): ReturnType<GatewayRuntimeFactory> {
  return factory({ systemApiHandler: handleSystemApiRequest, mode: extras?.mode });
}
