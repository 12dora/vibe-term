import { describe, expect, test } from 'bun:test';
import { loadWebAuthn, peekWebAuthn, resetWebAuthnLoaderForTests } from './webauthn-lazy';

describe('webauthn-lazy', () => {
  test('loadWebAuthn memoizes the module', async () => {
    resetWebAuthnLoaderForTests();
    expect(peekWebAuthn()).toBeUndefined();
    const first = await loadWebAuthn();
    const second = await loadWebAuthn();
    expect(first).toBe(second);
    expect(peekWebAuthn()).toBe(first);
    expect(typeof first.verifyAuthenticationResponse).toBe('function');
  });
});
