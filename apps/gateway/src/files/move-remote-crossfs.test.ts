import { afterEach, describe, expect, test } from 'bun:test';
import {
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

// 跨文件系统分支：把脚本里的目标设备号改成「不同」，真实 mv 在同一文件系统上做 rename，
// 但脚本走的是暂存 → 提交 → 回滚的路径；失败场景用 mv 桩函数模拟。

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

const DFS_LINE = 'DFS=$(fsid "$ddir")';
const GNU_PROBE =
  "if mv --help </dev/null 2>&1 | grep -q -e '--no-target-directory' -e '-T'; then T=-T; fi";

/** 替换脚本里的一段文本；找不到就报错，避免补丁悄悄失效。 */
function patch(script: string, from: string, to: string): string {
  if (!script.includes(from)) throw new Error(`script patch target missing: ${from}`);
  return script.replace(from, () => to);
}

/** 在第一条 `vt` 调用之前（探测之后）插入 shell 定义。 */
function inject(script: string, defs: string): string {
  return patch(script, '\nvt 0 ', `\n${defs}\nvt 0 `);
}

const forceCross = (script: string) => patch(script, DFS_LINE, "DFS='cross|device'");
const forceNonGnu = (script: string) => patch(script, GNU_PROBE, 'T=');

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

const tempEntries = (dir: string) =>
  readdirSync(join(dir, 'dest')).filter((name) => name.startsWith('.vtmv.'));

/** 暂存 mv 失败：在最后一个参数（临时项）里留下半成品，并可选地先建出别人的目标。 */
function failingStage(message: string, extra = ''): string {
  return `mv() { for a; do d=$a; done; printf partial > "$d"; ${extra}echo "${message}" >&2; return 1; }`;
}

describe('cross file system move: stage in a private temp, then rename', () => {
  test('files and directory trees move through the temp and leave nothing behind', async () => {
    const dir = sandbox();
    const logDir = sandbox();
    const log = join(logDir, 'calls.log');
    viaLocalSh((script) =>
      inject(forceCross(script), `mv() { printf '%s\\n' "mv $*" >> '${log}'; command mv "$@"; }`)
    );
    writeFileSync(join(dir, 'f'), 'file');
    mkdirSync(join(dir, 'd', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'd', 'sub', 'inner'), 'inner');

    const statuses = await runNames(dir, ['f', 'd']);

    expect(statuses).toEqual(['ok', 'ok']);
    expect(existsSync(join(dir, 'f'))).toBe(false);
    expect(existsSync(join(dir, 'd'))).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('file');
    expect(readFileSync(join(dir, 'dest', 'd', 'sub', 'inner'), 'utf8')).toBe('inner');
    expect(tempEntries(dir)).toEqual([]);
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/\.\/f \S+\/dest\/\.vtmv\.\d+\.0$/);
    expect(lines[1]).toMatch(/\.vtmv\.\d+\.0 \S+\/dest\/f$/);
  });

  test('an unknown file system id is treated as a different one', async () => {
    const dir = sandbox();
    const logDir = sandbox();
    const log = join(logDir, 'calls.log');
    viaLocalSh((script) =>
      inject(
        patch(script, DFS_LINE, 'DFS='),
        `mv() { printf '%s\\n' "mv $*" >> '${log}'; command mv "$@"; }`
      )
    );
    writeFileSync(join(dir, 'f'), 'file');

    expect(await runNames(dir, ['f'])).toEqual(['ok']);
    expect(readFileSync(log, 'utf8')).toContain('.vtmv.');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('file');
  });

  test('a failed staging removes only the temp and leaves a concurrent destination alone', async () => {
    viaLocalSh((script) =>
      inject(
        forceCross(script),
        failingStage('mv: write error: No space left on device', 'printf theirs > "$dp"; ')
      )
    );
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runNames(dir, ['f'])).toEqual(['unknown']);
    expect(tempEntries(dir)).toEqual([]);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('theirs');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
  });

  test('a staging failure never touches the public destination path', async () => {
    viaLocalSh((script) =>
      inject(forceCross(script), failingStage('mv: write error: No space left on device'))
    );
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runNames(dir, ['f'])).toEqual(['unknown']);
    expect(readdirSync(join(dir, 'dest'))).toEqual([]);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
  });

  test('a permission failure while staging maps to permission_denied and cleans the temp', async () => {
    viaLocalSh((script) =>
      inject(forceCross(script), failingStage('mv: cannot create regular file: Permission denied'))
    );
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runNames(dir, ['f'])).toEqual(['permission_denied']);
    expect(tempEntries(dir)).toEqual([]);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
  });

  test('cannot remove keeps the temp: it may be the only complete copy', async () => {
    viaLocalSh((script) =>
      inject(forceCross(script), failingStage("mv: cannot remove './f': Permission denied"))
    );
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runNames(dir, ['f'])).toEqual(['unknown']);
    const temps = tempEntries(dir);
    expect(temps).toHaveLength(1);
    expect(readFileSync(join(dir, 'dest', temps[0] ?? ''), 'utf8')).toBe('partial');
    expect(existsSync(join(dir, 'dest', 'f'))).toBe(false);
  });

  test('a source that is already gone after a failed staging keeps the temp', async () => {
    const stub = `mv() { for a; do d=$a; done; printf whole > "$d"; rm -f -- "$s"; echo 'mv: error writing: Input/output error' >&2; return 1; }`;
    viaLocalSh((script) => inject(forceCross(script), stub));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runNames(dir, ['f'])).toEqual(['unknown']);
    const temps = tempEntries(dir);
    expect(temps).toHaveLength(1);
    expect(readFileSync(join(dir, 'dest', temps[0] ?? ''), 'utf8')).toBe('whole');
  });

  test('a destination that appears after staging gets the data moved back (fail mode)', async () => {
    const stub = `mv() { command mv "$@"; _r=$?; case "$*" in *.vtmv.*) [ -e "$dp" ] || printf theirs > "$dp";; esac; return $_r; }`;
    viaLocalSh((script) => inject(forceCross(script), stub));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runNames(dir, ['f'])).toEqual(['already_exists']);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('theirs');
    expect(tempEntries(dir)).toEqual([]);
  });

  test('a blocked commit keeps the temp when the source path was taken meanwhile', async () => {
    const stub = `mv() { command mv "$@"; _r=$?; case "$*" in *.vtmv.*) [ -e "$dp" ] || printf theirs > "$dp"; [ -e "$s" ] || printf taken > "$s";; esac; return $_r; }`;
    viaLocalSh((script) => inject(forceCross(script), stub));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runNames(dir, ['f'])).toEqual(['unknown']);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('taken');
    const temps = tempEntries(dir);
    expect(temps).toHaveLength(1);
    expect(readFileSync(join(dir, 'dest', temps[0] ?? ''), 'utf8')).toBe('new');
  });
});

describe('cross file system overwrite', () => {
  const over = { overwrite: true };

  test('replaces an existing file', async () => {
    viaLocalSh(forceCross);
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');

    expect(await runNames(dir, ['f'], over)).toEqual(['ok']);
    expect(existsSync(join(dir, 'f'))).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(readdirSync(join(dir, 'dest'))).toEqual(['f']);
  });

  test('non-GNU: replaces an existing plain file with mv -f', async () => {
    viaLocalSh((script) => forceNonGnu(forceCross(script)));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');

    expect(await runNames(dir, ['f'], over)).toEqual(['ok']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(readdirSync(join(dir, 'dest'))).toEqual(['f']);
  });

  for (const nonGnu of [false, true]) {
    test(`replaces a destination symlink only (${nonGnu ? 'non-GNU swap' : 'default'})`, async () => {
      viaLocalSh((script) => (nonGnu ? forceNonGnu(forceCross(script)) : forceCross(script)));
      const dir = sandbox();
      mkdirSync(join(dir, 'target'));
      symlinkSync(join(dir, 'target'), join(dir, 'dest', 'f'));
      writeFileSync(join(dir, 'f'), 'new');

      expect(await runNames(dir, ['f'], over)).toEqual(['ok']);
      expect(lstatSync(join(dir, 'dest', 'f')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
      expect(readdirSync(join(dir, 'target'))).toEqual([]);
      expect(readdirSync(join(dir, 'dest'))).toEqual(['f']);
      expect(existsSync(join(dir, 'f'))).toBe(false);
    });
  }

  const failFinalReplace =
    'mv() { case " $*" in *\\ -f\\ *) echo "mv: boom" >&2; return 1;; esac; command mv "$@"; }';

  test('a failed atomic commit keeps the old file and restores the source', async () => {
    viaLocalSh((script) => inject(forceNonGnu(forceCross(script)), failFinalReplace));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');

    expect(await runNames(dir, ['f'], over)).toEqual(['unknown']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    expect(tempEntries(dir)).toEqual([]);
  });

  test.skipIf(!hasGnuMv)(
    'a failed mv -T commit keeps the old symlink and restores the source',
    async () => {
      viaLocalSh((script) => inject(forceCross(script), failFinalReplace));
      const dir = sandbox();
      mkdirSync(join(dir, 'target'));
      symlinkSync(join(dir, 'target'), join(dir, 'dest', 'f'));
      writeFileSync(join(dir, 'f'), 'new');

      expect(await runNames(dir, ['f'], over)).toEqual(['unknown']);
      expect(readlinkSync(join(dir, 'dest', 'f'))).toBe(join(dir, 'target'));
      expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
      expect(tempEntries(dir)).toEqual([]);
    }
  );

  test('non-GNU swap: a destination that appears after the link is removed is not overwritten', async () => {
    viaLocalSh((script) =>
      patch(
        forceNonGnu(forceCross(script)),
        'e=$(rm -f -- "$dp" 2>&1 </dev/null) ||',
        'e=$(rm -f -- "$dp" 2>&1 </dev/null; printf theirs > "$dp") ||'
      )
    );
    const dir = sandbox();
    mkdirSync(join(dir, 'target'));
    symlinkSync(join(dir, 'target'), join(dir, 'dest', 'f'));
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runNames(dir, ['f'], over)).toEqual(['already_exists']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('theirs');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    expect(tempEntries(dir)).toEqual([]);
  });

  test('non-GNU swap: a failed final rename restores the source', async () => {
    viaLocalSh((script) =>
      patch(forceNonGnu(forceCross(script)), 'mvn "$tp" "$dp"\n', '{ st=unknown; false; }\n')
    );
    const dir = sandbox();
    mkdirSync(join(dir, 'target'));
    symlinkSync(join(dir, 'target'), join(dir, 'dest', 'f'));
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runNames(dir, ['f'], over)).toEqual(['unknown']);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    expect(tempEntries(dir)).toEqual([]);
    expect(readdirSync(join(dir, 'dest'))).toEqual([]);
  });
});
