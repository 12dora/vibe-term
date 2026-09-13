import { describe, expect, test } from 'bun:test';
import { loadAcmeClient } from './acme-lazy';

describe('acme-lazy', () => {
  test('loadAcmeClient memoizes Client', async () => {
    const first = await loadAcmeClient();
    const second = await loadAcmeClient();
    expect(first).toBe(second);
    expect(typeof first.Client).toBe('function');
    expect(typeof first.crypto.createPrivateEcdsaKey).toBe('function');
  });
});
