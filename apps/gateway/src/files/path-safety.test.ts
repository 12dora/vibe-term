import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@vibeterm/shared';
import { checkAndNormalize, tokenDenyEnv } from './device-storage';

const LOCAL = { type: 'local' } as Device;
const SSH = { type: 'ssh' } as Device;

let sandbox: string;
let root: string;
let outside: string;

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-pathsafe-')));
  root = join(sandbox, 'root');
  outside = join(sandbox, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'hello.txt'), 'hi');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'escape'));
});

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe('checkAndNormalize — local (realpath enforced)', () => {
  test('allows files inside root', () => {
    const r = checkAndNormalize(LOCAL, root, join(root, 'hello.txt'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(join(root, 'hello.txt'));
  });
  test('allows nested dir', () => {
    expect(checkAndNormalize(LOCAL, root, join(root, 'sub')).ok).toBe(true);
  });
  test('rejects relative path', () => {
    expect(checkAndNormalize(LOCAL, root, 'hello.txt')).toEqual({ ok: false, code: 'invalid' });
  });
  test('rejects traversal escaping root', () => {
    expect(checkAndNormalize(LOCAL, root, `${root}/../outside/secret.txt`)).toEqual({
      ok: false,
      code: 'outside_roots',
    });
  });
  test('rejects symlink escaping root (realpath)', () => {
    expect(checkAndNormalize(LOCAL, root, join(root, 'escape'))).toEqual({
      ok: false,
      code: 'outside_roots',
    });
  });
  test('reports not_found for missing path', () => {
    expect(checkAndNormalize(LOCAL, root, join(root, 'nope'))).toEqual({
      ok: false,
      code: 'not_found',
    });
  });
});

describe('checkAndNormalize — ssh (textual containment, no realpath)', () => {
  test('allows path inside root', () => {
    const r = checkAndNormalize(SSH, '/home/u', '/home/u/code/app.ts');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe('/home/u/code/app.ts');
  });
  test('normalizes . and ..', () => {
    const r = checkAndNormalize(SSH, '/home/u', '/home/u/a/../b/./c');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe('/home/u/b/c');
  });
  test('rejects traversal escaping root', () => {
    expect(checkAndNormalize(SSH, '/home/u', '/home/u/../root')).toEqual({
      ok: false,
      code: 'outside_roots',
    });
  });
  test('rejects sibling-prefix path (no false containment)', () => {
    // /home/user2 must NOT be treated as inside /home/user
    expect(checkAndNormalize(SSH, '/home/user', '/home/user2/x')).toEqual({
      ok: false,
      code: 'outside_roots',
    });
  });
  test('rejects relative path', () => {
    expect(checkAndNormalize(SSH, '/home/u', 'rel')).toEqual({ ok: false, code: 'invalid' });
  });
});

describe('checkAndNormalize — token deny set (local realpath)', () => {
  const spies: Array<ReturnType<typeof spyOn>> = [];
  let home: string;

  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-tokdeny-')));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  function seedHomeInstall(): { appEnv: string; bashrc: string } {
    const install = join(home, '.local', 'share', 'vibeterm');
    mkdirSync(join(install, 'data'), { recursive: true });
    const appEnv = join(install, 'app.env');
    writeFileSync(appEnv, 'VIBETERM_MASTER_KEY=test');
    writeFileSync(join(install, 'data', 'vibeterm.db'), '');
    const bashrc = join(home, '.bashrc');
    writeFileSync(bashrc, 'echo hi');
    spies.push(spyOn(tokenDenyEnv, 'homedir').mockReturnValue(home));
    spies.push(
      spyOn(tokenDenyEnv, 'databaseUrl').mockReturnValue(join(install, 'data', 'vibeterm.db'))
    );
    return { appEnv, bashrc };
  }

  test('token principal cannot read app.env under a $HOME root', () => {
    const { appEnv } = seedHomeInstall();
    expect(checkAndNormalize(LOCAL, home, appEnv, { tokenPrincipal: true })).toEqual({
      ok: false,
      code: 'permission_denied',
    });
  });

  test('token principal cannot write .bashrc under a $HOME root', () => {
    const { bashrc } = seedHomeInstall();
    expect(checkAndNormalize(LOCAL, home, bashrc, { tokenPrincipal: true })).toEqual({
      ok: false,
      code: 'permission_denied',
    });
  });

  test('session principal still reads those paths', () => {
    const { appEnv, bashrc } = seedHomeInstall();
    expect(checkAndNormalize(LOCAL, home, appEnv).ok).toBe(true);
    expect(checkAndNormalize(LOCAL, home, bashrc).ok).toBe(true);
    expect(checkAndNormalize(LOCAL, home, appEnv, { tokenPrincipal: false }).ok).toBe(true);
  });

  test('token principal can read a non-secret file under the same $HOME root', () => {
    seedHomeInstall();
    const ok = join(home, 'ok.txt');
    writeFileSync(ok, 'ok');
    expect(checkAndNormalize(LOCAL, home, ok, { tokenPrincipal: true }).ok).toBe(true);
  });

  test('token principal cannot read ~/.ssh', () => {
    seedHomeInstall();
    mkdirSync(join(home, '.ssh'));
    const key = join(home, '.ssh', 'id_ed25519');
    writeFileSync(key, 'secret');
    expect(checkAndNormalize(LOCAL, home, key, { tokenPrincipal: true })).toEqual({
      ok: false,
      code: 'permission_denied',
    });
  });
});
