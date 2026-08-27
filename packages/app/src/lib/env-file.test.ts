import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeMissingEnvFileKeys,
  mergeMissingKeys,
  parseEnvContent,
  readEnvFile,
  stringifyEnv,
  writeEnvFile,
} from './env-file';
import { hubEnvDefaults } from './install';

describe('env-file', () => {
  test('parses env content', () => {
    const parsed = parseEnvContent('A=1\nB=hello\n# comment\n');
    expect(parsed).toEqual({ A: '1', B: 'hello' });
  });

  test('stringifies env with stable order', () => {
    const text = stringifyEnv({ B: '2', A: '1' });
    expect(text).toBe('A=1\nB=2\n');
  });

  test('mergeMissingKeys only adds absent keys', () => {
    const { next, added } = mergeMissingKeys(
      { TMEX_ROLES: 'node', GATEWAY_PORT: '9883' },
      hubEnvDefaults()
    );
    expect(next.TMEX_ROLES).toBe('node');
    expect(next.TMEX_HUB_URL).toBe('');
    expect(next.TMEX_PEER_PORT).toBe('39001');
    expect(next.TMEX_STUN_SERVERS).toContain('stun:stun.l.google.com:19302');
    expect(added).toContain('TMEX_HUB_URL');
    expect(added).not.toContain('TMEX_ROLES');
  });

  test('upgrade merge writes only missing app.env keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-env-'));
    try {
      const path = join(dir, 'app.env');
      await writeEnvFile(path, { TMEX_MASTER_KEY: 'k', GATEWAY_PORT: '9883' });
      const added = await mergeMissingEnvFileKeys(path, hubEnvDefaults());
      expect(added.sort()).toEqual(
        [
          'TMEX_HUB_PUBLIC_URL',
          'TMEX_HUB_URL',
          'TMEX_PEER_PORT',
          'TMEX_ROLES',
          'TMEX_STUN_SERVERS',
        ].sort()
      );
      const env = await readEnvFile(path);
      expect(env.TMEX_MASTER_KEY).toBe('k');
      expect(env.GATEWAY_PORT).toBe('9883');
      expect(env.TMEX_ROLES).toBe('standalone');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
