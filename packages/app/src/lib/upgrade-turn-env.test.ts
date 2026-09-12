import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLang, t } from '../i18n';
import { readEnvFile } from './env-file';
import { applyTurnEnvNotice, hasExternalTurnTriple } from './upgrade-turn-env';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempInstall(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-turn-env-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'app.env'), content, { encoding: 'utf8', mode: 0o600 });
  return dir;
}

describe('applyTurnEnvNotice', () => {
  test('logs when the legacy triple is present and does not delete keys', async () => {
    setLang('en');
    const dir = await tempInstall(
      'GATEWAY_PORT=9883\nVIBETERM_TURN_URL=turn:ext.example:3478\nVIBETERM_TURN_USERNAME=u\nVIBETERM_TURN_CREDENTIAL=p\n'
    );
    const logs: string[] = [];
    expect(await applyTurnEnvNotice(dir, (line) => logs.push(line))).toBe(true);
    expect(logs).toEqual([t('upgrade.turnExternalNotice')]);
    const env = await readEnvFile(join(dir, 'app.env'));
    expect(env.VIBETERM_TURN_URL).toBe('turn:ext.example:3478');
    expect(env.VIBETERM_TURN_USERNAME).toBe('u');
    expect(env.VIBETERM_TURN_CREDENTIAL).toBe('p');
  });

  test('is a no-op without the triple', async () => {
    const dir = await tempInstall('GATEWAY_PORT=9883\n');
    const logs: string[] = [];
    expect(await applyTurnEnvNotice(dir, (line) => logs.push(line))).toBe(false);
    expect(logs).toEqual([]);
    expect(hasExternalTurnTriple({ VIBETERM_TURN_URL: 'turn:x' })).toBe(false);
  });
});
