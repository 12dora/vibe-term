import { concatBytes, sha256 } from '@tmex/shared/auth';

export const REDEEM_POP_DOMAIN = 'tmex/redeem-pop/v1';

export function encodeRedeemPopMessage(input: {
  enrollmentId: string;
  nodeId: Uint8Array;
  certBytes: Uint8Array;
}): Uint8Array {
  if (input.nodeId.byteLength !== 16) {
    throw new Error('nodeId must be 16 bytes');
  }
  const enc = new TextEncoder();
  return concatBytes(
    enc.encode(REDEEM_POP_DOMAIN),
    new Uint8Array([0]),
    enc.encode(input.enrollmentId),
    new Uint8Array([0]),
    input.nodeId,
    sha256(input.certBytes)
  );
}
