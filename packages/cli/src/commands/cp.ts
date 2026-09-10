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
  r: 'boolean',
  progress: 'boolean',
  'no-progress': 'boolean',
  'on-conflict': 'string',
  'fail-on-skip': 'boolean',
} as const;

const CONFLICTS = new Set<OnConflict>(['overwrite', 'skip', 'rename']);

function expandShort(argv: string[]): string[] {
  return argv.map((token) => (token === '-r' ? '--recursive' : token));
}

function parseConflict(raw: string | undefined): OnConflict {
  if (raw === undefined) return 'skip';
  if (CONFLICTS.has(raw as OnConflict)) return raw as OnConflict;
  throw new UsageError(
    `--on-conflict must be overwrite|skip|rename, got "${raw}"`,
    'node-to-node copy supports overwrite|skip only'
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
      'usage: vibeterm cp <src> <dst>',
      'each side is [<node>:]<root>/<path> or a local path (./file, /abs, ~)'
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
        recursive: flagBool(flags, 'recursive') || flagBool(flags, 'r'),
        onConflict: parseConflict(flagString(flags, 'on-conflict')),
        failOnSkip: flagBool(flags, 'fail-on-skip'),
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
  summary: 'copy files between this machine and nodes',
  usage: [
    'Usage: vibeterm cp <src> <dst> [options]',
    '       vibeterm cp jobs ls|cancel <id>',
    '',
    'Each side is [<node>:]<rootId-or-name>/<path>, or a local path starting with',
    '/, ./, ../ or ~. Local-to-local is rejected (use system cp).',
    '',
    'Local→node: POST /api/files/mkdir {recursive:true} (once per dir, memoised),',
    '            then upload/init, 8 MiB PUT chunks with resume + jittered backoff, commit.',
    '            Recursive copy needs a node that implements mkdir; older nodes fail up front.',
    'Node→local: POST /api/files/download/prepare, GET content with Range resume.',
    'Node→node:  POST /n/<B>/api/transfer/grants then POST /n/<A>/api/transfer/jobs',
    '            and follow GET .../jobs/:id/events (NDJSON); if the stream ends without a',
    '            terminal state, poll GET .../jobs/:id until finishedAt is set.',
    '',
    'Options:',
    '  -r, --recursive              copy directories (local→node needs mkdir support)',
    '  --on-conflict overwrite|skip|rename   default skip (rename is local↔node only)',
    '  --fail-on-skip               exit 1 when any item was skipped (conflicts / symlinks)',
    '  --progress / --no-progress   stderr progress; default on for a TTY, off otherwise',
    '',
    '--json streams NDJSON progress events on stdout (no human tables):',
    '  {"type":"progress","phase":"upload|download|transfer|commit","bytes":n,"total":n,"pct":n}',
    '  {"type":"item","path":"rel","reason":"symlink|empty-dir|conflict"}',
    '  {"type":"done","path":"dst","files":n,"skipped":n,"errors":n,"truncated":false}',
    'cp jobs ls --json → { "jobs": [ { jobId, state, fromNodeId, toNodeId, progress, items } ] }',
    '',
    'Exit 1 if any error occurred or the listing was truncated; 130 on SIGINT/SIGTERM after',
    'DELETE of the in-flight upload/download session. Missing session: exit 3.',
  ].join('\n'),
  flags: FLAGS,
  run,
};
