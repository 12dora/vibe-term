import { describe, expect, test } from 'bun:test';
import {
  asDnsProviderId,
  inferDnsProviderFromSecret,
  normalizeDnsCredentials,
  parseDnsSecret,
  resolveStoredDnsCredentials,
  serializeDnsCredentials,
} from './dns-provider';

describe('dns-provider helpers', () => {
  test('normalizes cloudflare and dnspod credential shapes', () => {
    expect(asDnsProviderId('dnspod')).toBe('dnspod');
    expect(asDnsProviderId('route53')).toBeNull();
    expect(normalizeDnsCredentials('cloudflare', { token: '  abc  ' })).toEqual({ token: 'abc' });
    expect(normalizeDnsCredentials('dnspod', { id: '1', token: 't' })).toEqual({
      id: '1',
      token: 't',
    });
    expect(normalizeDnsCredentials('dnspod', { token: 'only' })).toBeNull();
    expect(parseDnsSecret('{"token":"x"}', 'cloudflare')).toEqual({ token: 'x' });
    expect(parseDnsSecret('not-json', 'cloudflare')).toBeNull();
    expect(serializeDnsCredentials({ id: '1', token: 't' })).toBe('{"id":"1","token":"t"}');
    expect(inferDnsProviderFromSecret('{"id":"1","token":"t"}')).toBe('dnspod');
    expect(inferDnsProviderFromSecret('{"token":"x"}')).toBe('cloudflare');
  });

  test('resolves legacy cf token when the JSON secret column is empty', () => {
    expect(
      resolveStoredDnsCredentials(
        { acmeDnsProvider: null },
        { acmeDnsSecret: null, acmeCfToken: 'legacy' }
      )
    ).toEqual({ provider: 'cloudflare', credentials: { token: 'legacy' } });
    expect(
      resolveStoredDnsCredentials(
        { acmeDnsProvider: 'dnspod' },
        { acmeDnsSecret: '{"id":"9","token":"k"}', acmeCfToken: 'legacy' }
      )
    ).toEqual({ provider: 'dnspod', credentials: { id: '9', token: 'k' } });
  });
});
