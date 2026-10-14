// `vibeterm cp`：local↔node 走 upload/download REST，node↔node 走 transfer grant + job。

import { flagBool, flagString, parseArgv } from '../core/args';
import type { CliContext } from '../core/context';
import { InterruptError, UsageError } from '../core/errors';
import { runCopy } from '../core/transfer-copy';
import { type OnConflict, cancelTransferJob, listTransferJobs } from '../core/transfer-peer';
import { CopyProgress } from '../core/transfer-progress';
import type { Command } from './types';

const FLAGS = {
  recursive: 'boolean',
  device: 'string',
  progress: 'boolean',
  'no-progress': 'boolean',
  'on-conflict': 'string',
  'fail-on-skip': 'boolean',
} as const;

const CONFLICTS = new Set<OnConflict>(['overwrite', 'skip', 'rename']);

const SHORT_TOKEN_RE = /^-[A-Za-z]+$/;

/** scp 习惯：`-r`/`-R` 递归，组合写法里的 `p` 忽略；其余短旗标明确拒绝。 */
function expandShort(argv: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      out.push(...argv.slice(index));
      break;
    }
    if (token === '-h' || !SHORT_TOKEN_RE.test(token)) {
      out.push(token);
      continue;
    }
    const letters = [...token.slice(1)];
    const unsupported = letters.find((letter) => !'rRp'.includes(letter));
    if (unsupported) {
      throw new UsageError(`cp 不支持选项 -${unsupported}`, '仅支持 -r（递归）；其余见 --help');
    }
    if (letters.some((letter) => letter === 'r' || letter === 'R')) out.push('--recursive');
  }
  return out;
}

function parseConflict(raw: string | undefined): OnConflict {
  if (raw === undefined) return 'overwrite';
  if (CONFLICTS.has(raw as OnConflict)) return raw as OnConflict;
  throw new UsageError(
    `--on-conflict 只接受 overwrite|skip|rename，收到 "${raw}"`,
    'node 到 node 复制只支持 overwrite|skip'
  );
}

function progressMode(ctx: CliContext, flags: ReturnType<typeof parseArgv>['flags']) {
  const json = ctx.globals.json;
  const forcedOff = flagBool(flags, 'no-progress');
  const forcedOn = flagBool(flags, 'progress');
  const tty = ctx.out.isStderrTty();
  const progress = forcedOff ? false : forcedOn ? true : json || tty;
  return { json, human: progress && !json, progress };
}

function installAbort(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  process.on('SIGINT', onAbort);
  process.on('SIGTERM', onAbort);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', onAbort);
      process.off('SIGTERM', onAbort);
    },
  };
}

async function run(ctx: CliContext, argv: string[]): Promise<number | undefined> {
  const { flags, positionals } = parseArgv(expandShort(argv), FLAGS);
  if (positionals[0] === 'jobs') return runJobs(ctx, positionals.slice(1));
  if (positionals.length !== 2) {
    throw new UsageError(
      'usage: vibeterm cp [-r] <src> <dst>',
      '远端写 <node>:<path>（冒号前不含 /），其余均为本地路径；详见 vibeterm cp --help'
    );
  }
  const progress = new CopyProgress(ctx.out, progressMode(ctx, flags));
  const abort = installAbort();
  try {
    const result = await runCopy(
      ctx,
      positionals[0],
      positionals[1],
      {
        recursive: flagBool(flags, 'recursive'),
        onConflict: parseConflict(flagString(flags, 'on-conflict')),
        failOnSkip: flagBool(flags, 'fail-on-skip'),
        device: flagString(flags, 'device'),
        signal: abort.signal,
      },
      progress
    );
    progress.emit({
      type: 'done',
      path: result.dst,
      files: result.files,
      skipped: result.skipped,
      errors: result.errors,
      truncated: result.truncated,
    });
    if (abort.signal.aborted) throw new InterruptError();
    if (!ctx.globals.json) {
      ctx.out.info(
        `copied ${result.files} file(s), skipped ${result.skipped}, errors ${result.errors} (${result.kind})`
      );
    }
    if (result.errors > 0 || result.truncated) return 1;
    if (flagBool(flags, 'fail-on-skip') && result.skipped > 0) return 1;
  } finally {
    abort.dispose();
    progress.finish();
  }
}

async function runJobs(ctx: CliContext, positionals: string[]): Promise<undefined> {
  const action = positionals[0];
  const nodeId = await ctx.targetNodeId();
  if (action === 'ls' || action === undefined) {
    const jobs = await listTransferJobs(ctx, nodeId);
    if (ctx.globals.json) {
      ctx.out.data({ jobs });
      return;
    }
    ctx.out.table(jobs, [
      { header: 'ID', value: (row) => row.jobId },
      { header: 'STATE', value: (row) => row.state },
      { header: 'FROM', value: (row) => row.fromNodeId },
      { header: 'TO', value: (row) => row.toNodeId },
      { header: 'BYTES', value: (row) => String(row.progress.transferredBytes) },
    ]);
    return;
  }
  if (action === 'cancel') {
    const id = positionals[1];
    if (!id) throw new UsageError('usage: vibeterm cp jobs cancel <id>');
    await cancelTransferJob(ctx, nodeId, id);
    if (ctx.globals.json) ctx.out.data({ cancelled: id });
    else ctx.out.line(`cancelled ${id}`);
    return;
  }
  throw new UsageError(`unknown cp jobs subcommand: ${action}`, 'use ls or cancel');
}

export const command: Command = {
  name: 'cp',
  summary: '在本机与节点之间复制文件（scp 语义）',
  usage: [
    'Usage: vibeterm cp [-r] [options] <src> <dst>',
    '       vibeterm cp jobs ls|cancel <id>',
    '',
    '语法与 scp 一致：冒号前不含 `/` 的是远端 <node>:<path>，其余一律视为本机路径',
    '（`dir`、`a/b`、`./x`、`../x`、`~/x`、绝对路径、`C:\\x` 均为本机）。两端都是本机时请用系统 cp。',
    '',
    '远端路径 <node>:<path>：',
    '  <node>:              节点的 home 目录；<node> 可为节点名、节点 id，或 self / local / .（入口节点）',
    '  <node>:/abs/path     设备上的绝对路径，须位于某个已启用的文件根内（取最长前缀的根）',
    '  <node>:rel/path      相对 home；首段恰为文件根 id 或名称时按该根解析（兼容旧写法 <node>:<root>/<rel>）',
    '  <rootId>:<rel>、fs-root:<rel>、home-root:<rel>   入口节点上的旧式根写法，行为不变',
    "  不在任何文件根内的路径会被拒绝；可在设置中添加文件根，或改用 rsync -e 'vibeterm rsh'。",
    '',
    '默认复制到节点的首个本机设备；多设备时用 --device 指定。',
    '',
    'Options:',
    '  -r, -R, --recursive          复制目录（组合写法如 -rp 可用，p 被忽略；其余短旗标不支持）',
    '  --device <id|name>           远端设备，默认节点的首个本机设备（node↔node 不支持）',
    '  --on-conflict overwrite|skip|rename   同名冲突策略，默认 overwrite（rename 仅限本机↔节点）',
    '  --fail-on-skip               有条目被跳过（冲突 / 符号链接等）时退出码为 1',
    '  --progress / --no-progress   stderr 进度；默认仅 TTY 开启',
    '',
    'Local→node: POST /api/files/mkdir {recursive:true}（每个目录一次），再 upload/init、',
    '            8 MiB 分片 PUT（断点续传 + 抖动退避）、commit。递归复制要求节点支持 mkdir。',
    'Node→local: POST /api/files/download/prepare，GET content（Range 续传）。',
    'Node→node:  POST /n/<B>/api/transfer/grants，再 POST /n/<A>/api/transfer/jobs，',
    '            跟随 GET .../jobs/:id/events（NDJSON）；流无终态时轮询 GET .../jobs/:id 直到 finishedAt。',
    '',
    '--json 在 stdout 输出 NDJSON 进度事件（无人类表格）：',
    '  {"type":"progress","phase":"upload|download|transfer|commit","bytes":n,"total":n,"pct":n,',
    '   "ratePerSec":n|null,"etaSec":n|null,"file":"rel-or-basename"|null}',
    '  {"type":"item","path":"rel","reason":"symlink|empty-dir|conflict"}',
    '  {"type":"done","path":"dst","files":n,"skipped":n,"errors":n,"truncated":false}',
    'cp jobs ls --json → { "jobs": [ { jobId, state, fromNodeId, toNodeId, progress, items } ] }',
    '',
    '出现错误或目录列表被截断时退出码为 1；SIGINT/SIGTERM 时退出码 130（会先 DELETE 进行中的上传 / 下载会话）。',
    '会话丢失：退出码 3。502 rsync_missing_local：退出码 5（本机设备已无需 rsync，SSH 设备仍需要）。',
  ].join('\n'),
  flags: FLAGS,
  run,
};
