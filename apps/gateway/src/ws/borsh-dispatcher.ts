import { wsBorsh } from '@tmex/shared';
import { createAgentKindHandlers } from './agent-kind-handlers';
import {
  type BorshDispatchHost,
  type BorshKindHandlerMap,
  decodeBorshKindPayload,
} from './borsh-kind-types';
import { createCanonicalKindHandlers } from './canonical-kind-handlers';
import type { GatewaySession } from './gateway-session';
import { createTmuxKindHandlers } from './tmux-kind-handlers';

export type {
  BorshDispatchHost,
  BorshKindHandler,
  BorshKindHandlerMap,
} from './borsh-kind-types';
export { decoderHandler, decodeBorshKindPayload, schemaHandler } from './borsh-kind-types';

export function createBorshKindHandlers(host: BorshDispatchHost): BorshKindHandlerMap {
  return new Map([
    ...createTmuxKindHandlers(host),
    ...createAgentKindHandlers(host),
    ...createCanonicalKindHandlers(host),
  ]);
}

export async function dispatchBorshKind(
  handlers: BorshKindHandlerMap,
  host: Pick<BorshDispatchHost, 'sendError'>,
  session: GatewaySession,
  kind: number,
  refSeq: number,
  payload: Uint8Array
): Promise<void> {
  const handler = handlers.get(kind);
  if (!handler) {
    host.sendError(session, refSeq, wsBorsh.ERROR_UNKNOWN_KIND, `Unknown kind: ${kind}`, false);
    return;
  }
  const decoded = decodeBorshKindPayload(handler, payload);
  await handler.handle(session, decoded, refSeq);
}
