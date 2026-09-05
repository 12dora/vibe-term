import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from './fs-utils';
import type { RunCommandResult } from './process';
import {
  OOM_DROP_IN_CONTENT,
  OOM_DROP_IN_FILENAME,
  ensureSystemdOomPolicyDropIn,
  parseDefaultOomPolicy,
  parseTmuxVersion,
  removeSystemdOomPolicyDropIn,
  shouldWarnAboutOomPolicy,
  systemdOomPolicyPaths,
} from './systemd-oom-policy';

const dirs: string[] = [];

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tmex-oom-'));
  dirs.push(dir);
  return join(dir, 'systemd');
}

function recorder() {
  const calls: string[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const run = async (command: string, args: string[]): Promise<RunCommandResult> => {
    calls.push([command, ...args].join(' '));
    return { code: 0, stdout: '', stderr: '' };
  };
  return {
    calls,
    logs,
    warns,
    run,
    log: (l: string) => logs.push(l),
    warn: (l: string) => warns.push(l),
  };
}

afterEach(() => {
  dirs.length = 0;
});

describe('ensureSystemdOomPolicyDropIn', () => {
  test('全新机器写入 drop-in 并 daemon-reexec', async () => {
    const configDir = await makeConfigDir();
    const rec = recorder();

    const outcome = await ensureSystemdOomPolicyDropIn({ configDir, ...rec });

    expect(outcome).toBe('written');
    const paths = systemdOomPolicyPaths(configDir);
    expect(await readFile(paths.dropIn, 'utf8')).toBe(OOM_DROP_IN_CONTENT);
    expect(OOM_DROP_IN_CONTENT).toContain('DefaultOOMPolicy=continue');
    expect(rec.calls).toEqual(['systemctl --user daemon-reexec']);
    expect(rec.warns).toEqual([]);
  });

  test('内容相同时幂等：不重写、不重载', async () => {
    const configDir = await makeConfigDir();
    const paths = systemdOomPolicyPaths(configDir);
    await mkdir(paths.dropInDir, { recursive: true });
    await writeFile(paths.dropIn, OOM_DROP_IN_CONTENT);
    const rec = recorder();

    const outcome = await ensureSystemdOomPolicyDropIn({ configDir, ...rec });

    expect(outcome).toBe('unchanged');
    expect(rec.calls).toEqual([]);
  });

  test('用户已在 user.conf 显式配置时跳过', async () => {
    const configDir = await makeConfigDir();
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'user.conf'), '[Manager]\nDefaultOOMPolicy=stop\n');
    const rec = recorder();

    const outcome = await ensureSystemdOomPolicyDropIn({ configDir, ...rec });

    expect(outcome).toBe('skipped-explicit');
    expect(await pathExists(systemdOomPolicyPaths(configDir).dropIn)).toBe(false);
    expect(rec.logs.join('\n')).toContain('user.conf');
    expect(rec.calls).toEqual([]);
  });

  test('其他 drop-in 显式配置时跳过；注释行不算配置', async () => {
    const configDir = await makeConfigDir();
    const paths = systemdOomPolicyPaths(configDir);
    await mkdir(paths.dropInDir, { recursive: true });
    await writeFile(join(paths.dropInDir, '00-comment.conf'), '#DefaultOOMPolicy=stop\n');
    const commentOnly = await ensureSystemdOomPolicyDropIn({ configDir, ...recorder() });
    expect(commentOnly).toBe('written');

    await writeFile(join(paths.dropInDir, '10-oom.conf'), '[Manager]\nDefaultOOMPolicy = kill\n');
    const rec = recorder();
    const outcome = await ensureSystemdOomPolicyDropIn({ configDir, ...rec });

    expect(outcome).toBe('skipped-explicit');
    expect(rec.logs.join('\n')).toContain('10-oom.conf');
  });

  test('目录不可创建时只告警，不抛错', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tmex-oom-'));
    dirs.push(parent);
    const blocker = join(parent, 'systemd');
    await writeFile(blocker, 'not a directory');
    const rec = recorder();

    const outcome = await ensureSystemdOomPolicyDropIn({ configDir: blocker, ...rec });

    expect(outcome).toBe('failed');
    expect(rec.warns).toHaveLength(1);
    expect(rec.warns[0]).toContain(OOM_DROP_IN_FILENAME);
    expect(rec.calls).toEqual([]);
  });

  test('daemon-reexec 失败时回退 daemon-reload', async () => {
    const configDir = await makeConfigDir();
    const calls: string[] = [];
    const warns: string[] = [];

    const outcome = await ensureSystemdOomPolicyDropIn({
      configDir,
      run: async (command, args) => {
        const line = [command, ...args].join(' ');
        calls.push(line);
        return line.endsWith('daemon-reexec')
          ? { code: 1, stdout: '', stderr: 'boom' }
          : { code: 0, stdout: '', stderr: '' };
      },
      log: () => undefined,
      warn: (line) => warns.push(line),
    });

    expect(outcome).toBe('written');
    expect(calls).toEqual(['systemctl --user daemon-reexec', 'systemctl --user daemon-reload']);
    expect(warns.join('\n')).toContain('daemon-reload');
  });

  test('两个重载都失败时只告警', async () => {
    const configDir = await makeConfigDir();
    const warns: string[] = [];

    const outcome = await ensureSystemdOomPolicyDropIn({
      configDir,
      run: async () => ({ code: 1, stdout: '', stderr: 'no session bus' }),
      log: () => undefined,
      warn: (line) => warns.push(line),
    });

    expect(outcome).toBe('written');
    expect(warns.join('\n')).toContain('no session bus');
  });
});

describe('removeSystemdOomPolicyDropIn', () => {
  test('逐字节相同才删除', async () => {
    const configDir = await makeConfigDir();
    const paths = systemdOomPolicyPaths(configDir);
    await mkdir(paths.dropInDir, { recursive: true });
    await writeFile(paths.dropIn, OOM_DROP_IN_CONTENT);
    const rec = recorder();

    expect(await removeSystemdOomPolicyDropIn({ configDir, ...rec })).toBe('removed');
    expect(await pathExists(paths.dropIn)).toBe(false);
    expect(rec.calls).toEqual(['systemctl --user daemon-reexec']);
  });

  test('用户改过的保留', async () => {
    const configDir = await makeConfigDir();
    const paths = systemdOomPolicyPaths(configDir);
    await mkdir(paths.dropInDir, { recursive: true });
    await writeFile(paths.dropIn, `${OOM_DROP_IN_CONTENT}# edited\n`);
    const rec = recorder();

    expect(await removeSystemdOomPolicyDropIn({ configDir, ...rec })).toBe('kept-modified');
    expect(await pathExists(paths.dropIn)).toBe(true);
    expect(rec.calls).toEqual([]);
  });

  test('文件不存在时无操作', async () => {
    const configDir = await makeConfigDir();
    const rec = recorder();
    expect(await removeSystemdOomPolicyDropIn({ configDir, ...rec })).toBe('absent');
    expect(rec.calls).toEqual([]);
  });
});

describe('parseTmuxVersion', () => {
  test.each([
    ['tmux 3.6\n', { major: 3, minor: 6 }],
    ['tmux 3.5a\n', { major: 3, minor: 5 }],
    ['tmux next-3.7', { major: 3, minor: 7 }],
    ['tmux 2.9a', { major: 2, minor: 9 }],
    ['tmux master', null],
    [null, null],
  ])('%p → %p', (input, expected) => {
    expect(parseTmuxVersion(input as string | null)).toEqual(expected);
  });
});

describe('parseDefaultOomPolicy', () => {
  test.each([
    ['DefaultOOMPolicy=stop\n', 'stop'],
    ['continue\n', 'continue'],
    ['DefaultOOMPolicy=CONTINUE', 'continue'],
    ['', null],
    [null, null],
  ])('%p → %p', (input, expected) => {
    expect(parseDefaultOomPolicy(input as string | null)).toBe(expected as string | null);
  });
});

describe('shouldWarnAboutOomPolicy', () => {
  test('stop + tmux 3.6 告警', () => {
    expect(shouldWarnAboutOomPolicy('DefaultOOMPolicy=stop', 'tmux 3.6')).toBe(true);
  });

  test('stop + tmux 版本未知也告警', () => {
    expect(shouldWarnAboutOomPolicy('DefaultOOMPolicy=stop', null)).toBe(true);
    expect(shouldWarnAboutOomPolicy('DefaultOOMPolicy=stop', 'tmux master')).toBe(true);
  });

  test('stop + tmux 3.5 不告警', () => {
    expect(shouldWarnAboutOomPolicy('DefaultOOMPolicy=stop', 'tmux 3.5a')).toBe(false);
  });

  test('continue 不告警', () => {
    expect(shouldWarnAboutOomPolicy('DefaultOOMPolicy=continue', 'tmux 3.6')).toBe(false);
    expect(shouldWarnAboutOomPolicy(null, 'tmux 3.6')).toBe(false);
  });
});
