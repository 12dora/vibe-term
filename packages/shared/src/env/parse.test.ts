import { describe, expect, test } from 'bun:test';
import { PORT_MAX, PORT_MIN, parseBoolEnv, parsePort } from './parse';

describe('parsePort', () => {
  test('accepts decimal integers in 1..65535', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('80')).toBe(80);
    expect(parsePort(' 9883 ')).toBe(9883);
    expect(parsePort(String(PORT_MAX))).toBe(PORT_MAX);
    expect(parsePort(String(PORT_MIN))).toBe(PORT_MIN);
  });

  test('rejects empty and non-decimal input', () => {
    expect(() => parsePort(undefined)).toThrow('port must be a decimal integer');
    expect(() => parsePort('')).toThrow('decimal integer');
    expect(() => parsePort('   ')).toThrow('decimal integer');
    expect(() => parsePort('abc')).toThrow('decimal integer');
    expect(() => parsePort('9663suffix')).toThrow('decimal integer');
    expect(() => parsePort('80.5')).toThrow('decimal integer');
    expect(() => parsePort('-1')).toThrow('decimal integer');
    expect(() => parsePort('+80')).toThrow('decimal integer');
  });

  test('rejects out-of-range values', () => {
    expect(() => parsePort('0')).toThrow('port must be an integer in 1..65535');
    expect(() => parsePort('65536')).toThrow('1..65535');
    expect(() => parsePort('99999')).toThrow('1..65535');
  });

  test('min 0 allows an OS-assigned dynamic port', () => {
    expect(parsePort('0', { min: 0 })).toBe(0);
    expect(() => parsePort('0')).toThrow('1..65535');
    expect(() => parsePort('65536', { min: 0 })).toThrow('0..65535');
  });

  test('fallback covers empty, invalid, and out-of-range', () => {
    expect(parsePort(undefined, { fallback: 9883 })).toBe(9883);
    expect(parsePort('', { fallback: 9883 })).toBe(9883);
    expect(parsePort('  ', { fallback: 9883 })).toBe(9883);
    expect(parsePort('abc', { fallback: 9883 })).toBe(9883);
    expect(parsePort('0', { fallback: 9883 })).toBe(9883);
    expect(parsePort('65536', { fallback: 9883 })).toBe(9883);
    expect(parsePort('443', { fallback: 9883 })).toBe(443);
  });

  test('name prefixes error messages', () => {
    expect(() => parsePort('nope', { name: 'GATEWAY_PORT' })).toThrow(
      'GATEWAY_PORT must be a decimal integer'
    );
    expect(() => parsePort('0', { name: 'GATEWAY_PORT' })).toThrow(
      'GATEWAY_PORT must be an integer in 1..65535'
    );
  });
});

describe('parseBoolEnv', () => {
  test('undefined uses the default; empty string is false', () => {
    expect(parseBoolEnv(undefined, true)).toBe(true);
    expect(parseBoolEnv(undefined, false)).toBe(false);
    expect(parseBoolEnv('', true)).toBe(false);
    expect(parseBoolEnv('', false)).toBe(false);
  });

  test('accepts 1 / true / yes, case-insensitive', () => {
    expect(parseBoolEnv('1', false)).toBe(true);
    expect(parseBoolEnv('true', false)).toBe(true);
    expect(parseBoolEnv('TRUE', false)).toBe(true);
    expect(parseBoolEnv('True', false)).toBe(true);
    expect(parseBoolEnv('yes', false)).toBe(true);
    expect(parseBoolEnv('YES', false)).toBe(true);
  });

  test('everything else is false, including on / 0 / false', () => {
    expect(parseBoolEnv('0', true)).toBe(false);
    expect(parseBoolEnv('false', true)).toBe(false);
    expect(parseBoolEnv('no', true)).toBe(false);
    expect(parseBoolEnv('on', true)).toBe(false);
    expect(parseBoolEnv(' true', true)).toBe(false);
  });
});
