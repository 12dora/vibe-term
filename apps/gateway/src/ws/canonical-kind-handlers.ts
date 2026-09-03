import { wsBorsh } from '@tmex/shared';
import { type BorshDispatchHost, type BorshKindHandler, decoderHandler } from './borsh-kind-types';
import { decodeCanonicalCommand } from './borsh/codec-borsh';

export function createCanonicalKindHandlers(
  host: BorshDispatchHost
): Array<[number, BorshKindHandler<unknown>]> {
  return [
    [
      wsBorsh.KIND_CANONICAL_COMMAND,
      decoderHandler(decodeCanonicalCommand, async (ws, decoded, refSeq) => {
        try {
          await host.getOrCreateCanonicalSession(ws).handleCommand(decoded.command);
        } catch (error) {
          const protocolError = error instanceof wsBorsh.WsBorshError ? error : null;
          host.sendError(
            ws,
            refSeq,
            protocolError?.code ?? wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
            protocolError?.message ?? 'Invalid canonical command',
            protocolError?.retryable ?? false
          );
        }
      }),
    ],
  ];
}
