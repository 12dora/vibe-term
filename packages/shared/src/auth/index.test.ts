import { describe, expect, it } from 'bun:test';
import * as auth from './index';

describe('@tmex/shared/auth barrel', () => {
  it('exports the identity primitives', () => {
    expect(typeof auth.deriveSeed).toBe('function');
    expect(typeof auth.createDelegation).toBe('function');
    expect(typeof auth.buildLogin).toBe('function');
    expect(typeof auth.verifyKeyLogChain).toBe('function');
    expect(typeof auth.createEnrollment).toBe('function');
    expect(typeof auth.deriveTotpKey).toBe('function');
    expect(typeof auth.encryptTotpSecret).toBe('function');
    expect(typeof auth.derivePeerSessionKeys).toBe('function');
    expect(auth.DOMAIN_DELEGATION).toBe('tmex/delegation/v1');
    expect(auth.KeyLogType['reset-root']).toBe('reset-root');
    expect(typeof auth.verifyDelegationTimes).toBe('function');
    expect(typeof auth.encodePasskeyAssertion).toBe('function');
    expect(auth.KEY_LOG_SIGNER_MATRIX['rotate-root']).toEqual(['root']);
    expect(auth.DELEGATION_CLOCK_SKEW_MS).toBe(60_000);
  });
});
