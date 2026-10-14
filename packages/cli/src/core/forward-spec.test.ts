import { describe, expect, test } from 'bun:test';
import { UsageError } from './errors';
import { parseForwardSpec, rewriteForwardArgv } from './forward-spec';

describe('parseForwardSpec', () => {
  const valid: Array<[string, Record<string, unknown>]> = [
    ['8080:127.0.0.1:80', { bindHost: '127.0.0.1', port: 8080, host: '127.0.0.1', hostPort: 80 }],
    ['8080:db.internal:5432', { bindHost: '127.0.0.1', port: 8080, host: 'db.internal' }],
    ['*:8080:localhost:80', { bindHost: '0.0.0.0', port: 8080, host: 'localhost' }],
    ['0.0.0.0:8080:h:80', { bindHost: '0.0.0.0' }],
    ['10.0.0.5:8080:h:80', { bindHost: '10.0.0.5', port: 8080 }],
    ['[::1]:8080:[::1]:80', { bindHost: '::1', port: 8080, host: '::1', hostPort: 80 }],
    ['8080:[fe80::1]:80', { bindHost: '127.0.0.1', host: 'fe80::1', hostPort: 80 }],
    ['[::]:8080:h:80', { bindHost: '::', host: 'h' }],
    ['65535:h:1', { port: 65535, hostPort: 1 }],
  ];
  for (const [raw, expected] of valid) {
    test(`parses ${raw}`, () => {
      expect(parseForwardSpec('L', raw)).toMatchObject({ kind: 'L', ...expected });
    });
  }

  test('keeps the kind', () => {
    expect(parseForwardSpec('R', '1:h:2').kind).toBe('R');
  });

  const invalid = [
    '',
    '8080',
    '8080:host',
    '0:h:80',
    '8080:h:0',
    '70000:h:80',
    '8080:h:65536',
    'abc:h:80',
    '8080:h:x',
    '8080:h:-1',
    '8080::80',
    ':8080:h:80',
    'a:b:c:d:e',
    '[::1:8080:h:80',
    '[::1]8080:h:80',
    '8080:h:80:',
  ];
  for (const raw of invalid) {
    test(`rejects "${raw}"`, () => {
      expect(() => parseForwardSpec('L', raw)).toThrow(UsageError);
    });
  }
});

describe('rewriteForwardArgv', () => {
  test('normalizes -L/-R with and without a space and drops -N', () => {
    expect(
      rewriteForwardArgv(['-L', '8080:h:80', '-R9000:h:90', '-N', '--persist', 'lab'])
    ).toEqual(['--local=8080:h:80', '--remote=9000:h:90', '--persist', 'lab']);
  });

  test('accepts clustered short flags and bracketed values', () => {
    expect(rewriteForwardArgv(['-NL8080:h:80', '-R', '[::1]:9:h:9', 'lab'])).toEqual([
      '--local=8080:h:80',
      '--remote=[::1]:9:h:9',
      'lab',
    ]);
  });

  test('is idempotent and keeps -h and the -- terminator', () => {
    const once = rewriteForwardArgv(['-L1:h:2', '-h', 'lab', '--', '-L']);
    expect(once).toEqual(['--local=1:h:2', '-h', 'lab', '--', '-L']);
    expect(rewriteForwardArgv(once)).toEqual(once);
  });

  test('rejects unknown short flags and a missing value', () => {
    expect(() => rewriteForwardArgv(['-D', '1080'])).toThrow(UsageError);
    expect(() => rewriteForwardArgv(['lab', '-L'])).toThrow(UsageError);
  });
});
