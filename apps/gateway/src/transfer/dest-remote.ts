// ssh 目标的落位。字节先在本机暂存目录收齐，再一次 ssh 往返「核对边界 + 建目录 + 探测冲突」，
// 最后一次 rsync 推过去；`skip` 用 rsync 的 `--ignore-existing` 兜底，避免探测与推送之间的抢跑。
//
// 残余风险：远端目录不在本进程控制下，核对与 rsync 之间仍有 TOCTOU 窗口（对端 root 可在两步之间
// 把目录换成符号链接）。本机目标没有这个窗口（逐段 lstat + realpath 复核）。

import type { FileErrorCode } from '@tmex/shared';
import { execSshCommand } from '../files/directory-browse';
import { classifyRsyncFailure, runRsync } from '../files/rsync';
import { type FileOpResult, fail, ok, withDeviceRsync } from '../files/rsync-operation';
import { type RsyncDeviceSpec, rsyncTargetArg } from '../files/ssh-command';
import { quoteShellArg } from '../tmux-client/command-builder';
import type { DestContext } from './dest';
import { splitRelPath } from './dest';

const WALK_TIMEOUT_MS = 20_000;
const PUSH_IDLE_TIMEOUT_MS = 120_000;

const EXIT_CODES: Readonly<Record<number, FileErrorCode>> = {
  61: 'outside_roots',
  62: 'outside_roots',
  63: 'permission_denied',
  64: 'not_a_directory',
  65: 'permission_denied',
  66: 'outside_roots',
};

/**
 * 远端一次性核对：root → destDir 的真实路径包含关系、relPath 每一段不是符号链接、
 * 缺失的段就地建出来，最后回报目标目录真实路径与同名文件是否已存在。
 */
function buildWalkCommand(ctx: DestContext, dirs: readonly string[], name: string): string {
  const lines = [
    `cd -- ${quoteShellArg(ctx.root.path)} || exit 60`,
    'r=$(pwd -P)',
    `cd -- ${quoteShellArg(ctx.destDir)} || exit 60`,
    'b=$(pwd -P)',
    'case "$b" in "$r"|"$r"/*) ;; *) exit 61;; esac',
  ];
  if (dirs.length > 0) {
    lines.push(
      `for s in ${dirs.map(quoteShellArg).join(' ')}; do`,
      'if [ -L "$s" ]; then exit 62; fi',
      'if [ ! -e "$s" ]; then mkdir -- "$s" || exit 63; fi',
      'if [ ! -d "$s" ]; then exit 64; fi',
      'cd -- "$s" || exit 65',
      'done',
      'd=$(pwd -P)',
      'case "$d" in "$b"|"$b"/*) ;; *) exit 66;; esac'
    );
  } else {
    lines.push('d="$b"');
  }
  lines.push(
    `if [ -e ${quoteShellArg(name)} ] || [ -L ${quoteShellArg(name)} ]; then e=1; else e=0; fi`,
    'printf \'TMEXDIR %s\\nTMEXEXISTS %s\\n\' "$d" "$e"'
  );
  return lines.join('\n');
}

function parseWalkOutput(stdout: Uint8Array): { dir: string; exists: boolean } | null {
  const text = new TextDecoder().decode(stdout);
  let dir: string | null = null;
  let exists: boolean | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('TMEXDIR ')) dir = line.slice(8).replace(/\r$/, '');
    else if (line.startsWith('TMEXEXISTS ')) exists = line.slice(11).trim() === '1';
  }
  return dir && exists !== null ? { dir, exists } : null;
}

async function walkRemote(
  spec: RsyncDeviceSpec,
  ctx: DestContext,
  rel: string
): Promise<FileOpResult<{ dir: string; name: string; exists: boolean }>> {
  const { dirs, name } = splitRelPath(rel);
  if (!name) return fail('invalid');
  const res = await execSshCommand(spec, buildWalkCommand(ctx, dirs, name), WALK_TIMEOUT_MS);
  if (res.exitCode !== 0) {
    const code = EXIT_CODES[res.exitCode];
    if (code) return fail(code, res.stderr);
    return fail(res.exitCode === 60 ? 'not_found' : 'connection_failed', res.stderr);
  }
  const parsed = parseWalkOutput(res.stdout);
  if (!parsed) return fail('unknown', res.stderr);
  return ok({ dir: parsed.dir, name, exists: parsed.exists });
}

function uploadArgs(
  spec: RsyncDeviceSpec,
  localSource: string,
  remoteDest: string,
  noClobber: boolean
): string[] {
  const args: string[] = ['--progress'];
  // 目标已存在就整个跳过：探测与推送之间的抢跑由 rsync 自己挡掉，不会覆盖别人刚落的文件
  if (noClobber) args.push('--ignore-existing');
  if (spec.rsh) args.push('-e', spec.rsh);
  args.push(localSource, rsyncTargetArg(spec, remoteDest));
  return args;
}

export interface RemotePlacement {
  /** 目标已存在且策略为 skip：没有推送任何字节 */
  skipped: boolean;
}

/**
 * 把本机暂存文件放到 ssh 目标上。一次 withDeviceRsync 内完成核对与推送，
 * 避免两次排队之间目录状态再变一次。
 */
export async function placeFileOnRemote(
  ctx: DestContext,
  input: {
    rel: string;
    localPath: string;
    onConflict: 'skip' | 'overwrite';
    signal?: AbortSignal;
  }
): Promise<FileOpResult<RemotePlacement>> {
  return withDeviceRsync<RemotePlacement>(ctx.device, async (spec) => {
    const walked = await walkRemote(spec, ctx, input.rel);
    if (!walked.ok) return walked;
    if (walked.data.exists && input.onConflict === 'skip') return ok({ skipped: true });
    const remoteDest = `${walked.data.dir}/${walked.data.name}`;
    const res = await runRsync(
      uploadArgs(spec, input.localPath, remoteDest, input.onConflict === 'skip'),
      {
        env: spec.env,
        idleTimeoutMs: PUSH_IDLE_TIMEOUT_MS,
        onProgress: () => {},
        signal: input.signal,
      }
    );
    if (res.exitCode !== 0) {
      return fail(classifyRsyncFailure(res.exitCode, res.stderr), res.stderr);
    }
    return ok({ skipped: false });
  });
}

/** 落位前的探测：核对边界、把缺失的目录建出来、回报同名文件是否已存在。 */
export async function probeRemoteTarget(
  ctx: DestContext,
  rel: string
): Promise<FileOpResult<{ dir: string; name: string; exists: boolean }>> {
  return withDeviceRsync(ctx.device, (spec) => walkRemote(spec, ctx, rel));
}

/** 只建目录（空目录条目走这条）：与文件落位共用同一套边界核对。 */
export async function ensureRemoteDir(
  ctx: DestContext,
  rel: string
): Promise<FileOpResult<{ dir: string }>> {
  return withDeviceRsync(ctx.device, async (spec) => {
    const walked = await walkRemote(spec, ctx, `${rel}/.keep`);
    if (!walked.ok) return walked;
    return ok({ dir: walked.data.dir });
  });
}
