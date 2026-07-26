import { handleSystemApiRequest } from '../../../../apps/gateway/src/api/system';
import { createGatewayRuntime } from '../../../../apps/gateway/src/runtime';

type GatewayRuntimeFactory = typeof createGatewayRuntime;

export function createTmexGatewayRuntime(
  factory: GatewayRuntimeFactory = createGatewayRuntime
): ReturnType<GatewayRuntimeFactory> {
  return factory({ systemApiHandler: handleSystemApiRequest });
}
