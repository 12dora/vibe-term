import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@vibeterm/shared';
import type { DeleteOutcome, DeleteStatus, DeleteTarget } from './delete-local';
import { deleteRemoteTargets } from './delete-remote';
import { remoteScriptIo } from './remote-script';
import * as sshCommand from './ssh-command';

const originalSpawn = remoteScriptIo.spawn;
const sandboxes: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

interface SpawnCall {
  argv: string[];
  script: string;
}

const device = { id: 'delete-remote-test', type: 'ssh' } as Device;

afterEach(() => {
  remoteScriptIo.spawn = originalSpawn;
  while (spies.length > 0) spies.pop()?.mockRestore();
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vt-delete-remote-')));
  sandboxes.push(dir);
  return dir;
}

/** 「远端」换成本机 `sh -s`：脚本照样走 stdin，argv 留给断言。 */
function useLocalSh(): SpawnCall[] {
  spies.push(
    spyOn(sshCommand, 'buildRsyncDeviceSpec').mockResolvedValue({
      targetPrefix: 'u@h:',
      rsh: 'ssh -p 22',
      env: {},
      cleanup: () => {},
    })
  );
  const calls: SpawnCall[] = [];
  remoteScriptIo.spawn = (argv, env, script) => {
    calls.push({ argv, script });
    return originalSpawn(['sh', '-s'], env, script);
  };
  return calls;
}

async function run(root: string, paths: readonly string[]): Promise<DeleteStatus[]> {
  const targets: DeleteTarget[] = paths.map((path, index) => ({ index, path }));
  const res = await deleteRemoteTargets(device, root, targets);
  if (!res.ok) throw new Error(`delete failed: ${res.code} ${res.detail ?? ''}`);
  const outcome: DeleteOutcome = res.data;
  return paths.map((_, index) => outcome.get(index) ?? 'unknown');
}

function gone(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch {
    return true;
  }
}

describe('远端删除：物理路径比较保留结尾换行', () => {
  test('root 真名以换行结尾，指向「无换行兄弟目录」的符号链接必须被拒绝', async () => {
    const base = sandbox();
    const root = join(base, 'root\n');
    const sibling = join(base, 'root');
    mkdirSync(root);
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'victim.txt'), 'keep');
    writeFileSync(join(root, 'own.txt'), 'x');
    symlinkSync(sibling, join(root, 'link'));
    useLocalSh();

    const codes = await run(root, [join(root, 'link', 'victim.txt'), join(root, 'own.txt')]);

    expect(codes).toEqual(['outside_roots', 'ok']);
    expect(existsSync(join(sibling, 'victim.txt'))).toBe(true);
    expect(gone(join(root, 'own.txt'))).toBe(true);
  });

  test('root 以换行结尾时，root 下的父目录与深层条目正常删除', async () => {
    const base = sandbox();
    const root = join(base, 'root\n');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'f'), 'x');
    useLocalSh();

    const codes = await run(root, [join(root, 'sub', 'f'), join(root, 'sub')]);

    expect(codes).toEqual(['ok', 'ok']);
    expect(gone(join(root, 'sub'))).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  test('root 内父目录名以换行结尾，正常删除且不误判越界', async () => {
    const root = sandbox();
    const parent = join(root, 'dir\n');
    mkdirSync(parent);
    writeFileSync(join(parent, 'a'), 'x');
    writeFileSync(join(parent, 'b\n'), 'x');
    useLocalSh();

    const codes = await run(root, [join(parent, 'a'), join(parent, 'b\n')]);

    expect(codes).toEqual(['ok', 'ok']);
    expect(gone(join(parent, 'a'))).toBe(true);
    expect(gone(join(parent, 'b\n'))).toBe(true);
    expect(existsSync(parent)).toBe(true);
  });

  test('父目录以换行结尾的符号链接指向 root 外，被拒绝', async () => {
    const root = sandbox();
    const outside = sandbox();
    writeFileSync(join(outside, 'victim.txt'), 'keep');
    symlinkSync(outside, join(root, 'ln\n'));
    useLocalSh();

    const codes = await run(root, [join(root, 'ln\n', 'victim.txt')]);

    expect(codes).toEqual(['outside_roots']);
    expect(existsSync(join(outside, 'victim.txt'))).toBe(true);
  });
});

describe('远端删除：脚本走 stdin', () => {
  test('500 项 × 255 字节文件名：脚本远超单参数上限，仍只在 stdin 里并执行成功', async () => {
    const root = sandbox();
    const paths = Array.from({ length: 500 }, (_, i) =>
      join(root, `${String(i).padStart(5, '0')}${'n'.repeat(250)}`)
    );
    for (const path of paths) writeFileSync(path, 'x');
    writeFileSync(join(root, 'keep'), 'x');
    const calls = useLocalSh();

    const codes = await run(root, paths);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.script.length).toBeGreaterThan(128 * 1024);
    expect(call?.argv).toEqual(['ssh', '-p', '22', 'u@h', 'sh -s']);
    expect(call?.argv.every((arg) => arg.length < 64)).toBe(true);
    expect(codes.every((code) => code === 'ok')).toBe(true);
    for (const path of paths) expect(gone(path)).toBe(true);
    expect(existsSync(join(root, 'keep'))).toBe(true);
  });

  test("文件名含 '、$、反引号、前导 -、空格与中间换行，原样删除且不波及邻居", async () => {
    const root = sandbox();
    const names = [
      "it's",
      '$(touch pwned)',
      '`touch pwned`',
      '$HOME',
      '-rf',
      '--no-preserve-root',
      'a b  c',
      'mid\nline',
      '"q" ; touch pwned',
    ];
    for (const name of names) writeFileSync(join(root, name), 'x');
    writeFileSync(join(root, 'keep'), 'x');
    useLocalSh();

    const codes = await run(
      root,
      names.map((name) => join(root, name))
    );

    expect(codes.every((code) => code === 'ok')).toBe(true);
    for (const name of names) expect(gone(join(root, name))).toBe(true);
    expect(existsSync(join(root, 'keep'))).toBe(true);
    expect(existsSync(join(root, 'pwned'))).toBe(false);
  });

  test('一项失败不影响其余项，符号链接只删链接本身', async () => {
    const root = sandbox();
    const outside = sandbox();
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, join(root, 'dirlink'));
    writeFileSync(join(root, 'a'), 'x');
    useLocalSh();

    const codes = await run(root, [
      join(root, 'missing'),
      join(root, 'dirlink', 'keep.txt'),
      join(root, 'dirlink'),
      join(root, 'a'),
    ]);

    expect(codes).toEqual(['not_found', 'outside_roots', 'ok', 'ok']);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(gone(join(root, 'dirlink'))).toBe(true);
  });

  test('root 不存在：整请求以 root_not_found 失败', async () => {
    const base = sandbox();
    useLocalSh();

    const res = await deleteRemoteTargets(device, join(base, 'nope'), [
      { index: 0, path: join(base, 'nope', 'x') },
    ]);

    expect(res).toMatchObject({ ok: false, code: 'root_not_found' });
  });
});
