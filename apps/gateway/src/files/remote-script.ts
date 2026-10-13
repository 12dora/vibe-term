// 在 ssh 设备上跑一段 POSIX sh 脚本：脚本走 stdin 交给 `sh -s`，不进 argv。
//
// 两个原因：登录 shell 不一定是 POSIX（fish / csh 读不懂 `case`、`$(...)`）；批量操作的脚本
// 带着几百个文件名，放进单个 argv 会撞上内核的单参数上限（Linux 128 KiB）。

import { errorMessage } from '@vibeterm/shared';
import type { RsyncDeviceSpec } from './ssh-command';

export interface RemoteScriptResult {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
}

export interface RemoteScriptProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

/** 与 `execSshCommand` 一致的退出码约定：起不来 255，超时 124。 */
export const REMOTE_SCRIPT_SPAWN_FAILED = 255;
export const REMOTE_SCRIPT_TIMED_OUT = 124;

const REMOTE_SHELL = 'sh -s';

/**
 * 取物理路径的 sh 函数：结果放进 `PHYS`，失败返回非零。
 * 不能写成 `x=$(pwd -P)`——命令替换会吃掉结尾的换行，目录名以换行结尾时拿到的是另一个路径，
 * 边界核对就对着错的目录做了。这里补一个哨兵字符再剥掉。
 */
export const SH_PHYS_FN =
  'phys() { _p=$(pwd -P && echo x) || return 1; _p=${_p%x}; PHYS=${_p%?}; }';

/** `inside <path> <root>`：path 等于 root 或在其下（两者都须是物理路径）。 */
export const SH_INSIDE_FN =
  'inside() { [ "$2" = / ] && return 0; case "$1" in "$2"|"$2"/*) return 0;; esac; return 1; }';

function spawnEnv(spec: RsyncDeviceSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return Object.assign(env, spec.env);
}

function spawnProcess(argv: string[], env: Record<string, string>, script: string) {
  const proc = Bun.spawn(argv, {
    env,
    stdin: new Blob([script]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited: proc.exited,
    kill: () => {
      try {
        proc.kill();
      } catch {
        // 已退出
      }
    },
  } satisfies RemoteScriptProcess;
}

export const remoteScriptIo = {
  spawn: spawnProcess,
};

/** 起进程并把 stdout 留给调用方流式读（打包下载用）；不是 ssh 设备返回 null。 */
export function spawnRemoteScript(
  spec: RsyncDeviceSpec,
  script: string
): RemoteScriptProcess | null {
  if (!spec.rsh) return null;
  const dest = spec.targetPrefix.replace(/:$/, '');
  return remoteScriptIo.spawn([...spec.rsh.split(' '), dest, REMOTE_SHELL], spawnEnv(spec), script);
}

/** 跑完整段脚本并收齐输出。 */
export async function execRemoteScript(
  spec: RsyncDeviceSpec,
  script: string,
  timeoutMs: number
): Promise<RemoteScriptResult> {
  let proc: RemoteScriptProcess | null;
  try {
    proc = spawnRemoteScript(spec, script);
  } catch (err) {
    return {
      stdout: new Uint8Array(),
      stderr: errorMessage(err),
      exitCode: REMOTE_SCRIPT_SPAWN_FAILED,
    };
  }
  if (!proc) {
    return {
      stdout: new Uint8Array(),
      stderr: 'not an ssh device',
      exitCode: REMOTE_SCRIPT_SPAWN_FAILED,
    };
  }

  let timedOut = false;
  const running = proc;
  const timer = setTimeout(() => {
    timedOut = true;
    running.kill();
  }, timeoutMs);
  try {
    const [stdoutBuf, stderr, exitCode] = await Promise.all([
      new Response(running.stdout).arrayBuffer(),
      new Response(running.stderr).text(),
      running.exited,
    ]);
    const stdout = new Uint8Array(stdoutBuf);
    if (timedOut) {
      return {
        stdout,
        stderr: `${stderr}\n[vibeterm] ssh timed out`,
        exitCode: REMOTE_SCRIPT_TIMED_OUT,
      };
    }
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}
