import { wsBorsh } from '@tmex/shared';
import { createAgentKindHandlers } from './agent-kind-handlers';
import {
  type BorshDispatchHost,
  type BorshKindHandlerMap,
  decodeBorshKindPayload,
} from './borsh-kind-types';
import { createCanonicalKindHandlers } from './canonical-kind-handlers';
import type { GatewaySession } from './gateway-session';
import {
  SHARE_FORBIDDEN_CODE,
  SHARE_FORBIDDEN_MESSAGE,
  recordShareCommand,
  shareDecodedInScope,
  shareKindPolicy,
} from './share-gate';
import type { SharePaneOracle } from './share-scope';
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

export type BorshDispatchGateHost = Pick<BorshDispatchHost, 'sendError'> & {
  sharePaneOracle?: (session: GatewaySession) => SharePaneOracle;
};

function rejectShare(host: BorshDispatchGateHost, session: GatewaySession, refSeq: number): void {
  host.sendError(session, refSeq, SHARE_FORBIDDEN_CODE, SHARE_FORBIDDEN_MESSAGE, false);
}

export async function dispatchBorshKind(
  handlers: BorshKindHandlerMap,
  host: BorshDispatchGateHost,
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
  const scope = session.shareScope;
  const policy = scope ? shareKindPolicy(kind) : 'deny';
  if (scope && policy === 'deny') {
    rejectShare(host, session, refSeq);
    return;
  }
  const decoded = decodeBorshKindPayload(handler, payload);
  if (scope) {
    const paneOracle = host.sharePaneOracle?.(session) ?? (() => false);
    if (!shareDecodedInScope(policy, scope, decoded, paneOracle)) {
      rejectShare(host, session, refSeq);
      return;
    }
    recordShareCommand(scope, kind, decoded);
  }
  await handler.handle(session, decoded, refSeq);
}
