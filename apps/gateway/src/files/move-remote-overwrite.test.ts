import { afterEach, describe, expect, test } from 'bun:test';
import {
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

const GNU_PROBE = 'if mv --help </dev/null 2>&1 | grep -q -- --no-target-directory; then T=-T; fi';
const FINAL_MV = 'e=$(mv -f -- "$tp" "$dp" 2>&1 </dev/null)';
const PRECHECK = 'if gone "$dp"; then mvn';

/** 替换脚本里的一段文本；找不到就报错，避免补丁悄悄失效。 */
function patch(script: string, from: string, to: string): string {
  if (!script.includes(from)) throw new Error(`script patch target missing: ${from}`);
  return script.replace(from, () => to);
}

/** 在第一条 `vt` 调用之前（GNU 探测之后）插入 shell 定义。 */
function inject(script: string, defs: string): string {
  return patch(script, '\nvt 0 ', `\n${defs}\nvt 0 `);
}

const forceNonGnu = (script: string) => patch(script, GNU_PROBE, 'T=');

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-move-ow-')));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'dest'));
  return dir;
}

function viaLocalSh(transform: (script: string) => string) {
  const scripts: string[] = [];
  fileMoveRemoteIo.hooks = { buildSpec: async () => fakeSpec };
  remoteScriptIo.spawn = (_argv, env, script) => {
    scripts.push(script);
    return originalSpawn(['sh', '-s'], env, transform(script));
  };
  return scripts;
}

async function runOne(dir: string, over: Partial<MoveBatch> = {}): Promise<string> {
  const batch: MoveBatch = {
    rootPath: dir,
    destRootPath: dir,
    destDir: join(dir, 'dest'),
    overwrite: false,
    items: [{ path: join(dir, 'f'), parent: dir, name: 'f', destName: 'f' }],
    ...over,
  };
  const result = await moveRemote(device, batch);
  if (!result.ok) return `request:${result.code}`;
  const outcome = result.data[0];
  return outcome?.ok ? 'ok' : (outcome?.code ?? 'missing');
}

const tempEntries = (dir: string) =>
  readdirSync(join(dir, 'dest')).filter((name) => name.startsWith('.vtmv.'));

/** 目标是指向目录的符号链接、源是新内容的覆盖场景。 */
function symlinkDestSetup(dir: string): string {
  const target = join(dir, 'target');
  mkdirSync(target);
  symlinkSync(target, join(dir, 'dest', 'f'));
  writeFileSync(join(dir, 'f'), 'new');
  return target;
}

describe('overwrite onto a destination symlink', () => {
  test.skipIf(!hasGnuMv)('GNU: one mv -T replaces the link, no rm, no temp', async () => {
    const dir = sandbox();
    const logDir = sandbox();
    const log = join(logDir, 'calls.log');
    const scripts = viaLocalSh((script) =>
      inject(
        script,
        [
          `mv() { printf '%s\\n' "mv $*" >> '${log}'; command mv "$@"; }`,
          `rm() { printf '%s\\n' "rm $*" >> '${log}'; command rm "$@"; }`,
        ].join('\n')
      )
    );
    const target = symlinkDestSetup(dir);

    const status = await runOne(dir, { overwrite: true });

    expect(status).toBe('ok');
    expect(scripts[0]).toContain('if [ -n "$T" ] || [ ! -L "$dp" ]; then');
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(lines).toEqual([`mv -f -T -- ./f ${join(dir, 'dest')}/f`]);
    expect(lstatSync(join(dir, 'dest', 'f')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(readdirSync(join(dir, 'dest'))).toEqual(['f']);
    expect(readdirSync(target)).toEqual([]);
  });

  test('non-GNU: a failed final mv puts the staged data back at the source', async () => {
    viaLocalSh((script) => patch(forceNonGnu(script), FINAL_MV, 'e=$(false)'));
    const dir = sandbox();
    symlinkDestSetup(dir);

    const status = await runOne(dir, { overwrite: true });

    expect(status).toBe('unknown');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    expect(tempEntries(dir)).toEqual([]);
    // 非 GNU 分支无法避免的窗口：旧链接已经 rm 掉了
    expect(readdirSync(join(dir, 'dest'))).toEqual([]);
  });

  test('non-GNU: a rollback never uses an occupied source path as a container', async () => {
    const dir = sandbox();
    const trap = join(dir, 'trap');
    mkdirSync(trap);
    // 最终 mv 失败的同时，源路径被换成了指向目录的符号链接
    viaLocalSh((script) =>
      patch(forceNonGnu(script), FINAL_MV, `e=$(ln -s '${trap}' "$s"; false)`)
    );
    symlinkDestSetup(dir);

    const status = await runOne(dir, { overwrite: true });

    expect(status).toBe('unknown');
    expect(lstatSync(join(dir, 'f')).isSymbolicLink()).toBe(true);
    expect(readdirSync(trap)).toEqual([]);
    const temps = tempEntries(dir);
    expect(temps).toHaveLength(1);
    expect(readFileSync(join(dir, 'dest', temps[0] ?? ''), 'utf8')).toBe('new');
  });

  test('non-GNU: a failed staging mv cleans its partial temp entry', async () => {
    const stub = `mv() { for a; do d=$a; done; printf partial > "$d"; echo 'mv: write error: No space left on device' >&2; return 1; }`;
    viaLocalSh((script) => inject(forceNonGnu(script), stub));
    const dir = sandbox();
    const target = symlinkDestSetup(dir);

    const status = await runOne(dir, { overwrite: true });

    expect(status).toBe('unknown');
    expect(tempEntries(dir)).toEqual([]);
    expect(readlinkSync(join(dir, 'dest', 'f'))).toBe(target);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
  });
});

describe('no-replace outcome classification', () => {
  const failWith = (message: string, leaveCopy: boolean) =>
    `mv() { for a; do d=$a; done; ${leaveCopy ? `printf partial > "$d"; ` : ''}echo "${message}" >&2; return 1; }`;

  test('an unrelated error is unknown and removes the partial destination', async () => {
    viaLocalSh((script) =>
      inject(script, failWith('mv: write error: No space left on device', true))
    );
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');

    const status = await runOne(dir);

    expect(status).toBe('unknown');
    expect(readdirSync(join(dir, 'dest'))).toEqual([]);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
  });

  test('a permission error maps to permission_denied', async () => {
    viaLocalSh((script) =>
      inject(script, failWith("mv: cannot create '.': Permission denied", false))
    );
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runOne(dir)).toBe('permission_denied');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
  });

  test('a failure while removing the source keeps the only complete copy', async () => {
    viaLocalSh((script) =>
      inject(script, failWith("mv: cannot remove './f': Permission denied", true))
    );
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');

    expect(await runOne(dir)).toBe('permission_denied');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('partial');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
  });

  test('not replacing and a silent skip are already_exists, destination kept', async () => {
    const stubs = [
      failWith("mv: not replacing './f'", false),
      failWith('mv: cannot move: File exists', false),
      'mv() { return 0; }',
    ];
    for (const stub of stubs) {
      // 预检被蒙过去：目标在检查之后才出现
      viaLocalSh((script) => inject(patch(script, PRECHECK, 'if true; then mvn'), stub));
      const dir = sandbox();
      writeFileSync(join(dir, 'f'), 'new');
      writeFileSync(join(dir, 'dest', 'f'), 'old');

      expect(await runOne(dir)).toBe('already_exists');
      expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('old');
      expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    }
  });
});
