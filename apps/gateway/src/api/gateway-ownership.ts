import { createHmac } from 'node:crypto';

const OWNER_PROOF_DOMAIN = 'vibex-gateway-owner-v1';
const CHALLENGE_PATTERN = /^[0-9a-f]{32,128}$/i;

export interface GatewayOwnerProof {
  pid: number;
  proof: string;
}

export function createGatewayOwnerProof(
  ownerToken: string | null,
  challenge: string | null,
  pid: number,
  tmuxHealthy: boolean
): GatewayOwnerProof | null {
  if (
    ownerToken === null ||
    challenge === null ||
    !/^[0-9a-f]{64}$/i.test(ownerToken) ||
    !CHALLENGE_PATTERN.test(challenge) ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  ) {
    return null;
  }
  const message = `${OWNER_PROOF_DOMAIN}\0${challenge.toLowerCase()}\0${pid}\0${tmuxHealthy ? '1' : '0'}`;
  return {
    pid,
    proof: createHmac('sha256', Buffer.from(ownerToken, 'hex')).update(message).digest('hex'),
  };
}
