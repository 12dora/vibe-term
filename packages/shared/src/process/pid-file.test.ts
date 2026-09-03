import { describe, expect, test } from 'bun:test';
import { parsePidFileRecord } from './pid-file';

describe('parsePidFileRecord', () => {
  test('accepts a plain-number pid file', () => {
    expect(parsePidFileRecord('12345\n')).toEqual({ pid: 12345 });
  });

  test('accepts JSON with identity and runtimePath', () => {
    expect(
      parsePidFileRecord(
        JSON.stringify({ pid: 9, identity: 'boot', runtimePath: '/tmp/server.js' })
      )
    ).toEqual({ pid: 9, identity: 'boot', runtimePath: '/tmp/server.js' });
  });

  test('rejects empty and non-positive', () => {
    expect(parsePidFileRecord('')).toBeNull();
    expect(parsePidFileRecord('0\n')).toBeNull();
    expect(parsePidFileRecord('-1')).toBeNull();
    expect(parsePidFileRecord('not-json')).toBeNull();
  });

  test('CLI-strict: JSON pid must be a number, not a numeric string', () => {
    expect(parsePidFileRecord(JSON.stringify({ pid: '12345' }))).toBeNull();
  });

  test('CLI-strict: bare JSON number is not an object record', () => {
    expect(parsePidFileRecord('12345')).toEqual({ pid: 12345 });
    expect(parsePidFileRecord('  "12345"  ')).toBeNull();
  });
});
