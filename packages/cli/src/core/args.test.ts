import { describe, expect, test } from 'bun:test';
import { GLOBAL_FLAGS, parseArgv, splitGlobalFlags } from './args';
import { UsageError } from './errors';

const SPEC = { ...GLOBAL_FLAGS, body: 'string', raw: 'boolean' } as const;

describe('parseArgv', () => {
  test('separates flags from positionals', () => {
    const parsed = parseArgv(['GET', '/api/devices', '--raw'], SPEC);
    expect(parsed.positionals).toEqual(['GET', '/api/devices']);
    expect(parsed.flags.raw).toBe(true);
  });

  test('accepts --key value and --key=value', () => {
    expect(parseArgv(['--body', '{"a":1}'], SPEC).flags.body).toBe('{"a":1}');
    expect(parseArgv(['--body={"a":1}'], SPEC).flags.body).toBe('{"a":1}');
  });

  test('coerces numbers', () => {
    expect(parseArgv(['--timeout', '500'], SPEC).flags.timeout).toBe(500);
    expect(() => parseArgv(['--timeout', 'soon'], SPEC)).toThrow(UsageError);
  });

  test('rejects unknown flags and missing values', () => {
    expect(() => parseArgv(['--nope'], SPEC)).toThrow(UsageError);
    expect(() => parseArgv(['--body'], SPEC)).toThrow(UsageError);
    expect(() => parseArgv(['--body', '--raw'], SPEC)).toThrow(UsageError);
  });

  test('a boolean flag rejects an inline value', () => {
    expect(() => parseArgv(['--raw=1'], SPEC)).toThrow(UsageError);
    expect(parseArgv(['--raw=false'], SPEC).flags.raw).toBe(false);
  });

  test('-- passes the rest through as positionals', () => {
    expect(parseArgv(['send', '--', '--literal'], SPEC).positionals).toEqual(['send', '--literal']);
  });
});

describe('splitGlobalFlags', () => {
  test('pulls global flags out and leaves the rest untouched', () => {
    const { globals, rest } = splitGlobalFlags(
      ['GET', '/api/devices', '--json', '--node', 'office', '--body', '{"a":1}'],
      SPEC
    );
    expect(globals).toEqual({ json: true, node: 'office' });
    expect(rest).toEqual(['GET', '/api/devices', '--body', '{"a":1}']);
  });

  test('-h is a global help flag', () => {
    expect(splitGlobalFlags(['-h'], SPEC).globals.help).toBe(true);
  });

  test('--key=value form is recognised on both sides', () => {
    const { globals, rest } = splitGlobalFlags(['--entry=http://x:1', '--body={"a":1}'], SPEC);
    expect(globals.entry).toBe('http://x:1');
    expect(rest).toEqual(['--body={"a":1}']);
  });

  test('unknown flags fail here rather than inside the command', () => {
    expect(() => splitGlobalFlags(['--nope'], SPEC)).toThrow(UsageError);
  });

  test('everything after -- stays in the command argv', () => {
    expect(splitGlobalFlags(['send', '--', '--json'], SPEC).rest).toEqual(['send', '--', '--json']);
  });
});
