import { describe, expect, test } from 'bun:test';

import { createGatewayOwnerProof } from './gateway-ownership';

describe('createGatewayOwnerProof', () => {
  const token = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  const challenge = '0123456789abcdef0123456789abcdef';

  test('binds the proof to the secret, challenge, and process id', () => {
    expect(createGatewayOwnerProof(token, challenge, 4242, true)).toEqual({
      pid: 4242,
      proof: 'c44ae823d1d72a8b487080d4dae68095a40f652f3ace28aceb78ffcd29cd675f',
    });
    expect(createGatewayOwnerProof(token, challenge, 4243, true)?.proof).not.toBe(
      createGatewayOwnerProof(token, challenge, 4242, true)?.proof
    );
    expect(createGatewayOwnerProof(token, challenge, 4242, false)?.proof).not.toBe(
      createGatewayOwnerProof(token, challenge, 4242, true)?.proof
    );
  });

  test('does not expose ownership without a valid managed challenge', () => {
    expect(createGatewayOwnerProof(null, challenge, 4242, true)).toBeNull();
    expect(createGatewayOwnerProof(token, 'short', 4242, true)).toBeNull();
    expect(createGatewayOwnerProof(token, challenge, 0, true)).toBeNull();
  });
});
