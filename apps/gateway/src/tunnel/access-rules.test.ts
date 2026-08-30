import { describe, expect, test } from 'bun:test';
import { parseAccessRules } from './access-rules';

describe('parseAccessRules', () => {
  test('requires at least one valid email or domain rule', () => {
    expect(() => parseAccessRules([])).toThrow();
    expect(parseAccessRules([{ kind: 'email', value: 'A@Example.COM' }])).toEqual([
      { kind: 'email', value: 'a@example.com' },
    ]);
    expect(parseAccessRules([{ kind: 'email_domain', value: 'Example.com' }])).toEqual([
      { kind: 'email_domain', value: 'example.com' },
    ]);
    expect(() => parseAccessRules([{ kind: 'email', value: 'not-an-email' }])).toThrow();
    expect(() => parseAccessRules([{ kind: 'email_domain', value: 'not a domain' }])).toThrow();
    expect(() => parseAccessRules([{ kind: 'email_domain', value: '@x.com' }])).toThrow();
  });
});
