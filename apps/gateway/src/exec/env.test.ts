import { afterEach, describe, expect, test } from 'bun:test';
import { buildChannelEnv, mergedServiceEnv, scrubbedBaseEnv } from './env';

const saved = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
});

function seedInternal(): void {
  process.env.VIBETERM_MASTER_KEY = 'secret';
  process.env.TMEX_TOKEN = 'legacy';
  process.env.DATABASE_URL = './x.db';
  process.env.NODE_ENV = 'production';
  process.env.GATEWAY_PORT = '9883';
  process.env.FE_PORT = '5173';
  process.env.KEEP_ME = 'yes';
}

describe('scrubbedBaseEnv', () => {
  test('drops service-internal keys and keeps the rest', () => {
    seedInternal();
    const env = scrubbedBaseEnv();
    expect(env.VIBETERM_MASTER_KEY).toBeUndefined();
    expect(env.TMEX_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.GATEWAY_PORT).toBeUndefined();
    expect(env.FE_PORT).toBeUndefined();
    expect(env.KEEP_ME).toBe('yes');
  });

  test('does not drop keys that merely contain the prefix', () => {
    process.env.MY_VIBETERM_X = '1';
    expect(scrubbedBaseEnv().MY_VIBETERM_X).toBe('1');
  });
});

describe('mergedServiceEnv', () => {
  test('scrubs then overlays, so an overlay may re-introduce a VIBETERM_ key', () => {
    seedInternal();
    const env = mergedServiceEnv({ VIBETERM_RSYNC_SECRET: 's', KEEP_ME: 'no' });
    expect(env.VIBETERM_MASTER_KEY).toBeUndefined();
    expect(env.VIBETERM_RSYNC_SECRET).toBe('s');
    expect(env.KEEP_ME).toBe('no');
  });
});

describe('buildChannelEnv', () => {
  test('applies PATH, SHELL, identity, TERM, then overlay', () => {
    seedInternal();
    const env = buildChannelEnv({
      shell: '/bin/zsh',
      path: '/opt/x/bin:/usr/bin',
      term: 'xterm-256color',
      overlay: { TERM: 'vt100', EXTRA: '1' },
    });
    expect(env.PATH).toBe('/opt/x/bin:/usr/bin');
    expect(env.SHELL).toBe('/bin/zsh');
    expect(env.TERM).toBe('vt100');
    expect(env.EXTRA).toBe('1');
    expect(env.HOME).toBeTruthy();
    expect(env.USER).toBeTruthy();
    expect(env.LOGNAME).toBe(env.USER);
    expect(env.VIBETERM_MASTER_KEY).toBeUndefined();
  });

  test('keeps the inherited PATH and omits TERM without a login PATH or pty', () => {
    process.env.PATH = '/inherited/bin';
    delete process.env.TERM;
    const env = buildChannelEnv({ shell: '/bin/sh', path: null, term: null });
    expect(env.PATH).toBe('/inherited/bin');
    expect(env.TERM).toBeUndefined();
  });

  test('falls back to a UTF-8 locale like tmux sessions, and the overlay still wins', () => {
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    process.env.LANG = 'C';
    expect(buildChannelEnv({ shell: '/bin/sh', path: null, term: null }).LC_ALL).toBe('C.UTF-8');
    expect(
      buildChannelEnv({ shell: '/bin/sh', path: null, term: null, overlay: { LC_ALL: 'C' } }).LC_ALL
    ).toBe('C');
    process.env.LANG = 'en_US.UTF-8';
    expect(buildChannelEnv({ shell: '/bin/sh', path: null, term: null }).LC_ALL).toBeUndefined();
  });
});
