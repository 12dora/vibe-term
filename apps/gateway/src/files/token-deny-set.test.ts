import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenDenyEnv, tokenLocalPathDenied } from './token-deny-set';

const dirs: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-denyset-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies.length = 0;
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('token deny set coverage', () => {
  test('covers VIBETERM_INSTALL_DIR even when DATABASE_URL is not under it', () => {
    const home = tempDir();
    const install = join(home, 'opt', 'vibeterm');
    mkdirSync(join(install, 'data'), { recursive: true });
    const appEnv = join(install, 'app.env');
    writeFileSync(appEnv, 'VIBETERM_MASTER_KEY=test');
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    spies.push(spyOn(tokenDenyEnv, 'databaseUrl').mockReturnValue(':memory:'));
    spies.push(spyOn(tokenDenyEnv, 'installDir').mockReturnValue(install));
    expect(tokenLocalPathDenied(appEnv)).toBe(true);
    expect(tokenLocalPathDenied(join(home, 'ok.txt'))).toBe(false);
  });

  test('covers XDG_CONFIG_HOME/vibeterm and VIBETERM_CLI_HOME', () => {
    const home = tempDir();
    const xdg = join(home, 'xdg');
    const cli = join(home, 'cli-home');
    mkdirSync(join(xdg, 'vibeterm'), { recursive: true });
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(xdg, 'vibeterm', 'tokens.json'), '{}');
    writeFileSync(join(cli, 'tokens.json'), '{}');
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    spies.push(spyOn(tokenDenyEnv, 'databaseUrl').mockReturnValue(':memory:'));
    spies.push(spyOn(tokenDenyEnv, 'xdgConfigHome').mockReturnValue(xdg));
    spies.push(spyOn(tokenDenyEnv, 'cliHome').mockReturnValue(cli));
    expect(tokenLocalPathDenied(join(xdg, 'vibeterm', 'tokens.json'))).toBe(true);
    expect(tokenLocalPathDenied(join(cli, 'tokens.json'))).toBe(true);
  });

  test('covers leftover tmex install dirs and Application Support trees', () => {
    const home = tempDir();
    const tmex = join(home, '.local', 'share', 'tmex');
    const macVt = join(home, 'Library', 'Application Support', 'vibeterm');
    const macTmex = join(home, 'Library', 'Application Support', 'tmex');
    mkdirSync(join(tmex, 'data'), { recursive: true });
    mkdirSync(macVt, { recursive: true });
    mkdirSync(macTmex, { recursive: true });
    writeFileSync(join(tmex, 'app.env'), 'x');
    writeFileSync(join(macVt, 'app.env'), 'x');
    writeFileSync(join(macTmex, 'app.env'), 'x');
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    spies.push(spyOn(tokenDenyEnv, 'databaseUrl').mockReturnValue(':memory:'));
    expect(tokenLocalPathDenied(join(tmex, 'app.env'))).toBe(true);
    expect(tokenLocalPathDenied(join(macVt, 'app.env'))).toBe(true);
    expect(tokenLocalPathDenied(join(macTmex, 'app.env'))).toBe(true);
  });

  test('darwin compares deny paths case-insensitively', () => {
    const home = tempDir();
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key');
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    spies.push(spyOn(tokenDenyEnv, 'databaseUrl').mockReturnValue(':memory:'));
    spies.push(spyOn(tokenDenyEnv, 'platform').mockReturnValue('darwin'));
    expect(tokenLocalPathDenied(join(home, '.SSH', 'id_ed25519'))).toBe(true);
    expect(tokenLocalPathDenied(join(home, 'Library', 'LaunchAgents', 'x.plist'))).toBe(true);
  });
});
