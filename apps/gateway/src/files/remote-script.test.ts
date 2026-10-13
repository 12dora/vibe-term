import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REMOTE_SCRIPT_SPAWN_FAILED,
  REMOTE_SCRIPT_TIMED_OUT,
  SH_INSIDE_FN,
  SH_PHYS_FN,
  execRemoteScript,
  remoteScriptIo,
  spawnRemoteScript,
} from './remote-script';
import type { RsyncDeviceSpec } from './ssh-command';

const originalSpawn = remoteScriptIo.spawn;
const sandboxes: string[] = [];

const sshSpec: RsyncDeviceSpec = {
  targetPrefix: 'user@host:',
  rsh: 'ssh -p 2222',
  env: { VT_TEST_ENV: '1' },
  cleanup: () => {},
};

/** 把「远端」换成本机 sh：argv 丢掉 ssh 前缀，只留最后的 `sh -s`。 */
function runLocally(calls: string[][] = []) {
  remoteScriptIo.spawn = (argv, env, script) => {
    calls.push(argv);
    return originalSpawn(['sh', '-s'], env, script);
  };
  return calls;
}

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vt-remote-script-')));
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  remoteScriptIo.spawn = originalSpawn;
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('execRemoteScript', () => {
  test('脚本走 stdin，argv 末尾只有 `sh -s`', async () => {
    const calls = runLocally();
    const res = await execRemoteScript(sshSpec, 'printf ok; exit 3', 5_000);
    expect(calls[0]).toEqual(['ssh', '-p', '2222', 'user@host', 'sh -s']);
    expect(new TextDecoder().decode(res.stdout)).toBe('ok');
    expect(res.exitCode).toBe(3);
  });

  test('几百 KB 的脚本不受单参数上限影响', async () => {
    runLocally();
    const filler = `: ${'x'.repeat(400_000)}`;
    const res = await execRemoteScript(sshSpec, `${filler}\nprintf done`, 5_000);
    expect(res.exitCode).toBe(0);
    expect(new TextDecoder().decode(res.stdout)).toBe('done');
  });

  test('不是 ssh 设备：不起进程，回 255', async () => {
    const res = await execRemoteScript({ ...sshSpec, rsh: undefined }, 'true', 5_000);
    expect(res.exitCode).toBe(REMOTE_SCRIPT_SPAWN_FAILED);
    expect(spawnRemoteScript({ ...sshSpec, rsh: undefined }, 'true')).toBeNull();
  });

  test('起进程抛错：回 255 并带上原因', async () => {
    remoteScriptIo.spawn = () => {
      throw new Error('ENOENT ssh');
    };
    const res = await execRemoteScript(sshSpec, 'true', 5_000);
    expect(res.exitCode).toBe(REMOTE_SCRIPT_SPAWN_FAILED);
    expect(res.stderr).toContain('ENOENT ssh');
  });

  test('超时：杀掉进程，回 124', async () => {
    runLocally();
    const res = await execRemoteScript(sshSpec, 'exec sleep 5', 100);
    expect(res.exitCode).toBe(REMOTE_SCRIPT_TIMED_OUT);
    expect(res.stderr).toContain('timed out');
  });
});

describe('sh 片段', () => {
  async function run(script: string): Promise<string> {
    runLocally();
    const res = await execRemoteScript(sshSpec, script, 5_000);
    expect(res.exitCode).toBe(0);
    return new TextDecoder().decode(res.stdout);
  }

  test('phys 保留目录名结尾的换行', async () => {
    const root = sandbox();
    const tricky = join(root, 'd\n');
    mkdirSync(tricky);
    const out = await run(
      [SH_PHYS_FN, `cd -- '${tricky}' || exit 9`, 'phys || exit 8', 'printf "%s|" "$PHYS"'].join(
        '\n'
      )
    );
    expect(out).toBe(`${tricky}|`);
  });

  test('phys 对普通目录给出物理路径', async () => {
    const root = sandbox();
    const out = await run(
      [SH_PHYS_FN, `cd -- '${root}' || exit 9`, 'phys || exit 8', 'printf "%s" "$PHYS"'].join('\n')
    );
    expect(out).toBe(root);
  });

  test('inside：自身与子路径算在内，同前缀的兄弟不算，根为 / 时一律在内', async () => {
    const out = await run(
      [
        SH_INSIDE_FN,
        'inside /a/b /a/b && printf 1 || printf 0',
        'inside /a/b/c /a/b && printf 1 || printf 0',
        'inside /a/bc /a/b && printf 1 || printf 0',
        'inside /x / && printf 1 || printf 0',
      ].join('\n')
    );
    expect(out).toBe('1101');
  });
});
