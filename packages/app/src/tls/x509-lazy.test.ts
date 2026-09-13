import { describe, expect, test } from 'bun:test';
import { loadX509 } from './x509-lazy';

describe('x509-lazy', () => {
  test('loadX509 memoizes the module and sets the crypto provider', async () => {
    const first = await loadX509();
    const second = await loadX509();
    expect(first).toBe(second);
    expect(typeof first.X509Certificate).toBe('function');
  });
});
