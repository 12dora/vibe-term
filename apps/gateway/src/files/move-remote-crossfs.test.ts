import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
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

// 跨挂载点路径：把脚本里的 `ln` 换成永远失败的 shell 函数，等价于「硬链接不可用」——
// 普通文件退回显式 cp，目录探针失败退回显式 cp -Rp 暂存。mv 只剩同目录 rename，从不复制。

const fakeSpec: RsyncDeviceSpec = {
  targetPrefix: 'user@host:',
  rsh: 'ssh -o BatchMode=yes',
  env: {},
  cleanup: () => {},
};

const device: Device = {
  id: 'move-remote-crossfs-test-device',
  name: 'move-remote-crossfs',
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
const isRoot = process.getuid?.() === 0;

afterEach(() => {
  fileMoveRemoteIo.exec = originalExec;
  fileMoveRemoteIo.hooks = originalHooks;
  remoteScriptIo.spawn = originalSpawn;
  for (const dir of sandboxes) {
    rmSync(dir, { recursive: true, force: true });
  }
  sandboxes.length = 0;
});

/** 在第一条 `vt` 调用之前插入 shell 定义（覆盖同名函数）。 */
function inject(script: string, defs: string): string {
  const marker = '\nvt 0 ';
  if (!script.includes(marker)) throw new Error('script patch target missing: vt 0');
  return script.replace(marker, () => `\n${defs}\n${marker.slice(1)}`);
}

const noLink = 'ln() { return 1; }';
const forceCopy = (script: string) => inject(script, noLink);
const withDefs =
  (...defs: string[]) =>
  (script: string) =>
    inject(script, [noLink, ...defs].join('\n'));

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-move-xfs-')));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'dest'));
  return dir;
}

function viaLocalSh(transform: (script: string) => string) {
  fileMoveRemoteIo.hooks = { buildSpec: async () => fakeSpec };
  remoteScriptIo.spawn = (_argv, env, script) =>
    originalSpawn(['sh', '-s'], env, transform(script));
}

async function runNames(
  dir: string,
  names: string[],
  over: Partial<MoveBatch> = {}
): Promise<string[]> {
  const batch: MoveBatch = {
    rootPath: dir,
    destRootPath: dir,
    destDir: join(dir, 'dest'),
    overwrite: false,
    items: names.map((name) => ({ path: join(dir, name), parent: dir, name, destName: name })),
    ...over,
  };
  const result = await moveRemote(device, batch);
  if (!result.ok) return [`request:${result.code}`];
  return result.data.map((outcome) => (outcome.ok ? 'ok' : outcome.code));
}

/** 源父目录与目标目录里的私有项（`.vtmv.*`，含目录探针文件）。 */
const leftovers = (dir: string) =>
  [dir, join(dir, 'dest')].flatMap((d) => readdirSync(d).filter((n) => n.startsWith('.vtmv.')));

/** 记录调用的工具桩：写一行日志再交给真实命令。 */
function logged(tool: string, log: string): string {
  return `${tool}() { printf '%s\\n' "${tool} $*" >> '${log}'; command ${tool} "$@"; }`;
}

const logLines = (log: string) =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];

/** 复制失败：在私有项里留下半成品再报错。 */
function failingCp(message: string, dirCopy = false): string {
  const make = dirCopy ? 'mkdir "$tp"; printf p > "$tp/partial"' : 'printf partial > "$tp"';
  return `cp() { ${make}; echo "${message}" >&2; return 1; }`;
}

describe('regular files without hard links: explicit copy, commit, then remove the source', () => {
  test('content and mode move over, and nothing is left behind', async () => {
    const logDir = sandbox();
    const log = join(logDir, 'calls.log');
    viaLocalSh(withDefs(logged('cp', log), logged('mv', log)));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'file');
    chmodSync(join(dir, 'f'), 0o640);

    expect(await runNames(dir, ['f'])).toEqual(['ok']);
    expect(existsSync(join(dir, 'f'))).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('file');
    expect(lstatSync(join(dir, 'dest', 'f')).mode & 0o777).toBe(0o640);
    expect(leftovers(dir)).toEqual([]);
    const lines = logLines(log);
    expect(lines[0]).toMatch(/^cp -p -- \.\/f \S+\/dest\/\.vtmv\.\d+\.0$/);
    expect(lines.filter((line) => line.startsWith('mv '))).toHaveLength(1);
  });

  test('a failing cp keeps the source and a pre-existing destination and removes its partial', async () => {
    viaLocalSh(withDefs(failingCp('cp: error writing: No space left on device')));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');

    expect(await runNames(dir, ['f'], { overwrite: true })).toEqual(['unknown']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    expect(leftovers(dir)).toEqual([]);
  });

  test('a failing cp into a free destination leaves it free', async () => {
    viaLocalSh(withDefs(failingCp('cp: cannot create regular file: Permission denied')));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runNames(dir, ['f'])).toEqual(['permission_denied']);
    expect(readdirSync(join(dir, 'dest'))).toEqual([]);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
  });

  test('overwrite replaces a regular file and a symlink entry through the copy', async () => {
    viaLocalSh(forceCopy);
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');
    writeFileSync(join(dir, 'g'), 'g-new');
    mkdirSync(join(dir, 'target'));
    symlinkSync(join(dir, 'target'), join(dir, 'dest', 'g'));

    expect(await runNames(dir, ['f', 'g'], { overwrite: true })).toEqual(['ok', 'ok']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(lstatSync(join(dir, 'dest', 'g')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'g'), 'utf8')).toBe('g-new');
    expect(readdirSync(join(dir, 'target'))).toEqual([]);
    expect(readdirSync(join(dir, 'dest')).sort()).toEqual(['f', 'g']);
    expect(leftovers(dir)).toEqual([]);
  });

  test('a destination that appears while copying is never replaced (fail mode)', async () => {
    viaLocalSh(withDefs('cp() { command cp "$@"; printf theirs > "$dp"; }'));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'mine');

    expect(await runNames(dir, ['f'])).toEqual(['already_exists']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('theirs');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('mine');
    expect(leftovers(dir)).toEqual([]);
  });

  test('awkward names survive the copy path', async () => {
    viaLocalSh(forceCopy);
    const dir = sandbox();
    const names = ['-dash', "it's", 'a b', '$HOME', 'new\nline'];
    for (const name of names) writeFileSync(join(dir, name), name);

    expect(await runNames(dir, names)).toEqual(names.map(() => 'ok'));
    for (const name of names) {
      expect(existsSync(join(dir, name))).toBe(false);
      expect(readFileSync(join(dir, 'dest', name), 'utf8')).toBe(name);
    }
    expect(leftovers(dir)).toEqual([]);
  });
});

describe('directories: probe decides, mv only ever renames', () => {
  test('probe success: one mv -n, no copy, probe files removed', async () => {
    const logDir = sandbox();
    const log = join(logDir, 'calls.log');
    viaLocalSh((script) => inject(script, [logged('cp', log), logged('mv', log)].join('\n')));
    const dir = sandbox();
    mkdirSync(join(dir, 'd', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'd', 'sub', 'inner'), 'inner');

    expect(await runNames(dir, ['d'])).toEqual(['ok']);
    expect(existsSync(join(dir, 'd'))).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'd', 'sub', 'inner'), 'utf8')).toBe('inner');
    expect(leftovers(dir)).toEqual([]);
    const lines = logLines(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^mv -n (-T )?-- \.\/d \S+\/dest\/d$/);
  });

  test('probe failure: staged cp -Rp with nested content, then rename and remove the source', async () => {
    const logDir = sandbox();
    const log = join(logDir, 'calls.log');
    viaLocalSh(withDefs(logged('cp', log)));
    const dir = sandbox();
    mkdirSync(join(dir, 'd', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'd', 'sub', 'inner'), 'inner');
    writeFileSync(join(dir, 'd', '.hidden'), 'hidden');
    symlinkSync('sub/inner', join(dir, 'd', 'ln'));

    expect(await runNames(dir, ['d'])).toEqual(['ok']);
    expect(existsSync(join(dir, 'd'))).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'd', 'sub', 'inner'), 'utf8')).toBe('inner');
    expect(readFileSync(join(dir, 'dest', 'd', '.hidden'), 'utf8')).toBe('hidden');
    expect(readlinkSync(join(dir, 'dest', 'd', 'ln'))).toBe('sub/inner');
    expect(leftovers(dir)).toEqual([]);
    expect(logLines(log)[0]).toMatch(/^cp -Rp -- \.\/d \S+\/dest\/\.vtmv\.\d+\.0$/);
  });

  test('a failing staged copy keeps the source and removes only its own partial', async () => {
    viaLocalSh(withDefs(failingCp('cp: error writing: No space left on device', true)));
    const dir = sandbox();
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'inner'), 'inner');

    expect(await runNames(dir, ['d'])).toEqual(['unknown']);
    expect(readFileSync(join(dir, 'd', 'inner'), 'utf8')).toBe('inner');
    expect(readdirSync(join(dir, 'dest'))).toEqual([]);
    expect(leftovers(dir)).toEqual([]);
  });

  test('a destination that appears while copying is neither entered nor replaced', async () => {
    const intruder = 'cp() { command cp "$@"; mkdir "$dp"; printf keep > "$dp/keep"; }';
    viaLocalSh(withDefs(intruder));
    const dir = sandbox();
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'inner'), 'inner');

    expect(await runNames(dir, ['d'])).toEqual(['already_exists']);
    expect(readdirSync(join(dir, 'dest', 'd'))).toEqual(['keep']);
    expect(readFileSync(join(dir, 'd', 'inner'), 'utf8')).toBe('inner');
    expect(leftovers(dir)).toEqual([]);
  });

  test('an unremovable source after the staged commit keeps a complete destination', async () => {
    const failRm =
      'rm() { case "$*" in *" -- ./d") echo "rm: cannot remove: Permission denied" >&2; return 1;; esac; command rm "$@"; }';
    viaLocalSh(withDefs(failRm));
    const dir = sandbox();
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'inner'), 'inner');

    expect(await runNames(dir, ['d'])).toEqual(['permission_denied']);
    expect(readFileSync(join(dir, 'dest', 'd', 'inner'), 'utf8')).toBe('inner');
    expect(readFileSync(join(dir, 'd', 'inner'), 'utf8')).toBe('inner');
    expect(leftovers(dir)).toEqual([]);
  });

  test('an existing destination is already_exists even with overwrite, and nothing changes', async () => {
    viaLocalSh(forceCopy);
    const dir = sandbox();
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'inner'), 'inner');
    mkdirSync(join(dir, 'dest', 'd'));
    writeFileSync(join(dir, 'dest', 'd', 'keep'), 'keep');

    expect(await runNames(dir, ['d'], { overwrite: true })).toEqual(['already_exists']);
    expect(readdirSync(join(dir, 'dest', 'd'))).toEqual(['keep']);
    expect(readFileSync(join(dir, 'd', 'inner'), 'utf8')).toBe('inner');
    expect(leftovers(dir)).toEqual([]);
  });

  test('a failed mv -n rename reports from the file system and cleans nothing', async () => {
    const failMv =
      'mv() { printf partial > "$dp"; echo "mv: cannot move: Operation not permitted" >&2; return 1; }';
    viaLocalSh((script) => inject(script, failMv));
    const dir = sandbox();
    mkdirSync(join(dir, 'd'));

    // 源仍在、目标出现：不是我们的东西，也不是我们能判断的半成品，保留并按 already_exists 报告
    expect(await runNames(dir, ['d'])).toEqual(['already_exists']);
    expect(readFileSync(join(dir, 'dest', 'd'), 'utf8')).toBe('partial');
    expect(existsSync(join(dir, 'd'))).toBe(true);
  });

  test.skipIf(isRoot)('a source parent that cannot hold the probe file fails safely', async () => {
    viaLocalSh(forceCopy);
    const dir = sandbox();
    mkdirSync(join(dir, 'ro', 'd'), { recursive: true });
    writeFileSync(join(dir, 'ro', 'd', 'inner'), 'inner');
    chmodSync(join(dir, 'ro'), 0o555);
    try {
      const items = [
        { path: join(dir, 'ro', 'd'), parent: join(dir, 'ro'), name: 'd', destName: 'd' },
      ];
      expect(await runNames(dir, [], { items })).toEqual(['permission_denied']);
    } finally {
      chmodSync(join(dir, 'ro'), 0o755);
    }
    expect(readFileSync(join(dir, 'ro', 'd', 'inner'), 'utf8')).toBe('inner');
    expect(readdirSync(join(dir, 'dest'))).toEqual([]);
  });

  test('awkward directory names survive the staged copy', async () => {
    viaLocalSh(forceCopy);
    const dir = sandbox();
    const names = ['-dir', "it's dir", '$HOME dir', 'new\nline dir'];
    for (const name of names) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'inner'), name);
    }

    expect(await runNames(dir, names)).toEqual(names.map(() => 'ok'));
    for (const name of names) {
      expect(existsSync(join(dir, name))).toBe(false);
      expect(readFileSync(join(dir, 'dest', name, 'inner'), 'utf8')).toBe(name);
    }
    expect(leftovers(dir)).toEqual([]);
  });
});
