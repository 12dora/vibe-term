import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@vibeterm/shared';
import { fileMoveRemoteIo, moveRemote } from './move-remote';
import type { MoveBatch } from './move-types';
import { remoteScriptIo } from './remote-script';
import type { RsyncDeviceSpec } from './ssh-command';

// 提交与覆盖语义：所有场景都在本机真实 `sh -s` 里跑生成的脚本，失败 / 竞态用 shell 函数桩或补丁注入。

const fakeSpec: RsyncDeviceSpec = {
  targetPrefix: 'user@host:',
  rsh: 'ssh -o BatchMode=yes',
  env: {},
  cleanup: () => {},
};

const device: Device = {
  id: 'move-remote-overwrite-test-device',
  name: 'move-remote-overwrite',
  type: 'ssh',
  host: '127.0.0.1',
  username: 'nobody',
  authMode: 'agent',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const originalExec = fileMoveRemoteIo.exec;
const originalHooks = fileMoveRemoteIo.hooks;
const originalSpawn = remoteScriptIo.spawn;
const sandboxes: string[] = [];

afterEach(() => {
  fileMoveRemoteIo.exec = originalExec;
  fileMoveRemoteIo.hooks = originalHooks;
  remoteScriptIo.spawn = originalSpawn;
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
});

const hasGnuMv = new TextDecoder()
  .decode(Bun.spawnSync(['mv', '--help']).stdout)
  .includes('--no-target-directory');

const GNU_PROBE =
  "if mv --help </dev/null 2>&1 | grep -q -e '--no-target-directory' -e '-T'; then T=-T; fi";

/** 替换脚本里的一段文本；找不到就报错，避免补丁悄悄失效。 */
function patch(script: string, from: string, to: string): string {
  if (!script.includes(from)) throw new Error(`script patch target missing: ${from}`);
  return script.replace(from, () => to);
}

/** 在第一条 `vt` 调用之前插入 shell 定义（覆盖同名函数）。 */
function inject(script: string, defs: string): string {
  return patch(script, '\nvt 0 ', `\n${defs}\nvt 0 `);
}

/** 蒙过 vt 预检与 cmt 的最后确认，只剩 `mv -n`（及 GNU 的 -T）把关。 */
const skipChecks = 'cmt() { mvn "$1" "$2"; }';
const openPrecheck = (script: string) =>
  patch(script, 'elif gone "$dp"; then put n', 'elif true; then put n');

/** 任何以私有项 tp 为参数的 mv 都失败：模拟提交 rename 出错（旧目标 / 备份的 mv 不受影响）。 */
const failTpMv =
  'mv() { for a in "$@"; do if [ "$a" = "$tp" ]; then echo "mv: boom" >&2; return 1; fi; done; command mv "$@"; }';

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-move-ow-')));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'dest'));
  return dir;
}

function viaLocalSh(transform: (script: string) => string = (script) => script) {
  fileMoveRemoteIo.hooks = { buildSpec: async () => fakeSpec };
  remoteScriptIo.spawn = (_argv, env, script) =>
    originalSpawn(['sh', '-s'], env, transform(script));
}

async function runOne(dir: string, over: Partial<MoveBatch> = {}, name = 'f'): Promise<string> {
  const batch: MoveBatch = {
    rootPath: dir,
    destRootPath: dir,
    destDir: join(dir, 'dest'),
    overwrite: false,
    items: [{ path: join(dir, name), parent: dir, name, destName: name }],
    ...over,
  };
  const result = await moveRemote(device, batch);
  if (!result.ok) return `request:${result.code}`;
  const outcome = result.data[0];
  return outcome?.ok ? 'ok' : (outcome?.code ?? 'missing');
}

/** 源父目录与目标目录里的私有项（`.vtmv.*`）。 */
const leftovers = (dir: string) =>
  [dir, join(dir, 'dest')].flatMap((d) => readdirSync(d).filter((n) => n.startsWith('.vtmv.')));

function symlinkDest(dir: string): string {
  const target = join(dir, 'target');
  mkdirSync(target);
  symlinkSync(target, join(dir, 'dest', 'f'));
  return target;
}

describe('commit and overwrite of a regular file', () => {
  test('a plain move leaves neither temp nor backup and removes the source last', async () => {
    viaLocalSh();
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'data');

    expect(await runOne(dir)).toBe('ok');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('data');
    expect(existsSync(join(dir, 'f'))).toBe(false);
    expect(leftovers(dir)).toEqual([]);
  });

  test('overwrite atomically replaces an existing regular file', async () => {
    viaLocalSh();
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');

    expect(await runOne(dir, { overwrite: true })).toBe('ok');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'f'))).toBe(false);
    expect(readdirSync(join(dir, 'dest'))).toEqual(['f']);
    expect(leftovers(dir)).toEqual([]);
  });

  test('a failed replace keeps the old destination and the source', async () => {
    viaLocalSh((script) => inject(script, failTpMv));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');

    expect(await runOne(dir, { overwrite: true })).toBe('unknown');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    expect(leftovers(dir)).toEqual([]);
  });

  test('a failed commit in fail mode removes the private temp and keeps the source', async () => {
    viaLocalSh((script) => inject(script, failTpMv));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runOne(dir)).toBe('unknown');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    expect(readdirSync(join(dir, 'dest'))).toEqual([]);
  });

  test('an intruder file between obtaining the temp and the commit survives untouched', async () => {
    for (const transform of [(s: string) => s, (s: string) => inject(s, skipChecks)]) {
      viaLocalSh((script) =>
        transform(patch(script, 'mkp || return 1', 'mkp || return 1; printf theirs > "$dp"'))
      );
      const dir = sandbox();
      writeFileSync(join(dir, 'f'), 'mine');

      expect(await runOne(dir)).toBe('already_exists');
      expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('theirs');
      expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('mine');
      expect(leftovers(dir)).toEqual([]);
    }
  });

  test.skipIf(!hasGnuMv)('an intruder directory is not used as a container', async () => {
    viaLocalSh((script) =>
      inject(patch(script, 'mkp || return 1', 'mkp || return 1; mkdir "$dp"'), skipChecks)
    );
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'mine');

    expect(await runOne(dir)).toBe('already_exists');
    expect(readdirSync(join(dir, 'dest', 'f'))).toEqual([]);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('mine');
    expect(leftovers(dir)).toEqual([]);
  });

  test('the fooled pre-check still cannot replace an existing file in fail mode', async () => {
    viaLocalSh((script) => inject(openPrecheck(script), skipChecks));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'mine');
    writeFileSync(join(dir, 'dest', 'f'), 'theirs');

    expect(await runOne(dir)).toBe('already_exists');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('theirs');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('mine');
    expect(leftovers(dir)).toEqual([]);
  });
});

describe('overwrite onto a destination symlink', () => {
  test('the link entry is replaced and nothing is written into its target', async () => {
    viaLocalSh();
    const dir = sandbox();
    const target = symlinkDest(dir);
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runOne(dir, { overwrite: true })).toBe('ok');
    expect(lstatSync(join(dir, 'dest', 'f')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(readdirSync(target)).toEqual([]);
    expect(readdirSync(join(dir, 'dest'))).toEqual(['f']);
    expect(existsSync(join(dir, 'f'))).toBe(false);
  });

  test('a forced commit failure puts the old symlink back and keeps the source', async () => {
    viaLocalSh((script) => inject(script, failTpMv));
    const dir = sandbox();
    const target = symlinkDest(dir);
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runOne(dir, { overwrite: true })).toBe('unknown');
    expect(readlinkSync(join(dir, 'dest', 'f'))).toBe(target);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    expect(readdirSync(target)).toEqual([]);
    expect(readdirSync(join(dir, 'dest'))).toEqual(['f']);
    expect(leftovers(dir)).toEqual([]);
  });

  test('a destination occupied during the swap is kept and the old link stays as backup', async () => {
    viaLocalSh((script) => inject(script, 'cmt() { printf theirs > "$2"; mvn "$1" "$2"; }'));
    const dir = sandbox();
    const target = symlinkDest(dir);
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runOne(dir, { overwrite: true })).toBe('already_exists');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('theirs');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    const kept = leftovers(dir);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/\.bak$/);
    expect(readlinkSync(join(dir, 'dest', kept[0] ?? ''))).toBe(target);
  });

  test('a symlink source replaces a regular file as a link, with the same backup rules', async () => {
    viaLocalSh();
    const dir = sandbox();
    writeFileSync(join(dir, 'real'), 'x');
    symlinkSync('real', join(dir, 'f'));
    writeFileSync(join(dir, 'dest', 'f'), 'old');

    expect(await runOne(dir, { overwrite: true })).toBe('ok');
    expect(readlinkSync(join(dir, 'dest', 'f'))).toBe('real');
    expect(existsSync(join(dir, 'f'))).toBe(false);
    expect(readFileSync(join(dir, 'real'), 'utf8')).toBe('x');
    expect(leftovers(dir)).toEqual([]);
  });

  test('a failed symlink replace restores the old file and keeps the source link', async () => {
    const failSource =
      'mv() { for a in "$@"; do if [ "$a" = "$s" ]; then echo "mv: boom" >&2; return 1; fi; done; command mv "$@"; }';
    viaLocalSh((script) => inject(script, failSource));
    const dir = sandbox();
    writeFileSync(join(dir, 'real'), 'x');
    symlinkSync('real', join(dir, 'f'));
    writeFileSync(join(dir, 'dest', 'f'), 'old');

    expect(await runOne(dir, { overwrite: true })).toBe('unknown');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('old');
    expect(readlinkSync(join(dir, 'f'))).toBe('real');
    expect(leftovers(dir)).toEqual([]);
  });
});

describe('source removal and the same-inode rule', () => {
  const failSourceRm =
    'rm() { case "$*" in *" -- ./f") echo "rm: cannot remove: Permission denied" >&2; return 1;; esac; command rm "$@"; }';

  test('an unremovable source after commit reports permission_denied and a retry completes', async () => {
    viaLocalSh((script) => inject(script, failSourceRm));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'data');

    expect(await runOne(dir)).toBe('permission_denied');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('data');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('data');
    expect(leftovers(dir)).toEqual([]);

    viaLocalSh();
    expect(await runOne(dir)).toBe('ok');
    expect(existsSync(join(dir, 'f'))).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('data');
  });

  test('a retry in overwrite mode also finishes instead of becoming a no-op', async () => {
    viaLocalSh((script) => inject(script, failSourceRm));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'data');
    expect(await runOne(dir, { overwrite: true })).toBe('permission_denied');

    viaLocalSh();
    expect(await runOne(dir, { overwrite: true })).toBe('ok');
    expect(existsSync(join(dir, 'f'))).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('data');
  });

  test('same parent, same inode: a plain rename that never removes a name', async () => {
    const logDir = sandbox();
    const log = join(logDir, 'calls.log');
    viaLocalSh((script) =>
      inject(script, `rm() { printf '%s\\n' "rm $*" >> '${log}'; command rm "$@"; }`)
    );
    const dir = sandbox();
    writeFileSync(join(dir, 'a'), 'data');
    // 同目录两个硬链接：脚本分不清它与「大小写别名」，两种情况都不得删除任何名字
    linkSync(join(dir, 'a'), join(dir, 'b'));

    for (const overwrite of [false, true]) {
      const items = [{ path: join(dir, 'a'), parent: dir, name: 'a', destName: 'b' }];
      expect(await runOne(dir, { destDir: dir, overwrite, items })).toBe('ok');
      expect(readFileSync(join(dir, 'a'), 'utf8')).toBe('data');
      expect(readFileSync(join(dir, 'b'), 'utf8')).toBe('data');
    }
    expect(existsSync(log)).toBe(false);
  });
});

describe('mv -T is only extra protection on mv -n commits', () => {
  test.skipIf(!hasGnuMv)('GNU: commits use mv -n -T, never mv -f -T', async () => {
    const logDir = sandbox();
    const log = join(logDir, 'calls.log');
    viaLocalSh((script) =>
      inject(script, `mv() { printf '%s\\n' "mv $*" >> '${log}'; command mv "$@"; }`)
    );
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'data');

    expect(await runOne(dir)).toBe('ok');
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^mv -n -T -- \S+\/dest\/\.vtmv\.\d+\.0 \S+\/dest\/f$/);
  });

  test('without -T every scenario still behaves the same', async () => {
    viaLocalSh((script) => patch(script, GNU_PROBE, 'T='));
    const dir = sandbox();
    const target = symlinkDest(dir);
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'g'), 'g-new');
    writeFileSync(join(dir, 'dest', 'g'), 'g-old');

    expect(await runOne(dir, { overwrite: true })).toBe('ok');
    expect(await runOne(dir, { overwrite: true }, 'g')).toBe('ok');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(readFileSync(join(dir, 'dest', 'g'), 'utf8')).toBe('g-new');
    expect(readdirSync(target)).toEqual([]);
    expect(leftovers(dir)).toEqual([]);
  });

  test.skipIf(!hasGnuMv)('BusyBox-style help that lists only -T still enables -T', async () => {
    const logDir = sandbox();
    const log = join(logDir, 'calls.log');
    const stub = [
      'mv() {',
      `if [ "$1" = --help ]; then echo 'Usage: mv [-fin] [-T] SOURCE DEST'; return 0; fi`,
      `printf '%s\\n' "mv $*" >> '${log}'; command mv "$@"`,
      '}',
    ].join('\n');
    viaLocalSh((script) => patch(script, '\nT=\n', `\n${stub}\nT=\n`));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'data');

    expect(await runOne(dir)).toBe('ok');
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(lines.at(-1)).toMatch(/^mv -n -T -- /);
  });
});
