import { describe, expect, test } from 'bun:test';
import { DEFAULT_ENTRY, configDir, normalizeEntry, pickEntry, sessionFilePath } from './config';
import { UsageError } from './errors';

describe('configDir', () => {
  test('VIBETERM_CLI_HOME wins', () => {
    expect(configDir({ VIBETERM_CLI_HOME: '/tmp/cli', XDG_CONFIG_HOME: '/xdg' }, '/home/u')).toBe(
      '/tmp/cli'
    );
  });

  test('XDG_CONFIG_HOME is next', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' }, '/home/u')).toBe('/xdg/vibeterm');
  });

  test('falls back to ~/.config/vibeterm', () => {
    expect(configDir({}, '/home/u')).toBe('/home/u/.config/vibeterm');
  });

  test('blank values are ignored', () => {
    expect(configDir({ VIBETERM_CLI_HOME: '  ', XDG_CONFIG_HOME: '' }, '/home/u')).toBe(
      '/home/u/.config/vibeterm'
    );
  });

  test('session file lives in the config dir', () => {
    expect(sessionFilePath('/home/u/.config/vibeterm')).toBe(
      '/home/u/.config/vibeterm/session.json'
    );
  });
});

describe('normalizeEntry', () => {
  test('adds a scheme and strips trailing slashes', () => {
    expect(normalizeEntry('example.com:9883/')).toBe('http://example.com:9883');
    expect(normalizeEntry('https://example.com/')).toBe('https://example.com');
  });

  test('keeps a base path', () => {
    expect(normalizeEntry('https://example.com/vt/')).toBe('https://example.com/vt');
  });

  test.each(['', '   ', 'ftp://example.com', 'http://'])('rejects %p', (input) => {
    expect(() => normalizeEntry(input)).toThrow(UsageError);
  });
});

describe('pickEntry precedence', () => {
  const sources = {
    flag: 'http://flag:1',
    env: 'http://env:2',
    session: 'http://session:3',
    install: 'http://install:4',
  };

  test('--entry beats everything', () => {
    expect(pickEntry(sources)).toBe('http://flag:1');
  });

  test('env beats the session file', () => {
    expect(pickEntry({ ...sources, flag: undefined })).toBe('http://env:2');
  });

  test('session file beats the local install', () => {
    expect(pickEntry({ ...sources, flag: undefined, env: undefined })).toBe('http://session:3');
  });

  test('the local install beats the built-in default', () => {
    expect(pickEntry({ install: sources.install })).toBe('http://install:4');
  });

  test('built-in default is the local gateway', () => {
    expect(pickEntry({})).toBe(DEFAULT_ENTRY);
  });
});
