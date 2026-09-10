// `vibeterm cp`：local↔node 走 upload/download REST，node↔node 走 transfer grant + job。

import { flagBool, flagString, parseArgv } from '../core/args';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import { runCopy } from '../core/transfer-copy';
import { type OnConflict, cancelTransferJob, listTransferJobs } from '../core/transfer-peer';
import { CopyProgress } from '../core/transfer-progress';
import type { Command } from './types';

const FLAGS = {
  recursive: 'boolean',
  r: 'boolean',
  progress: 'boolean',
  'on-conflict': 'string',
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

async function run(ctx: CliContext, argv: string[]): Promise<number | undefined> {
  const { flags, positionals } = parseArgv(expandShort(argv), FLAGS);
  if (positionals[0] === 'jobs') return runJobs(ctx, positionals.slice(1));
  if (positionals.length !== 2) {
    throw new UsageError(
      'usage: vibeterm cp <src> <dst>',
      'each side is [<node>:]<root>/<path> or a local path (./file, /abs, ~)'
    );
  }
  const progress = new CopyProgress(ctx.out, ctx.globals.json);
  try {
    const result = await runCopy(
      ctx,
      positionals[0],
      positionals[1],
      {
        recursive: flagBool(flags, 'recursive') || flagBool(flags, 'r'),
        onConflict: parseConflict(flagString(flags, 'on-conflict')),
      },
      progress
    );
    progress.emit({ type: 'done', path: result.dst });
    if (ctx.globals.json) return;
    ctx.out.info(`copied ${result.files} file(s), skipped ${result.skipped} (${result.kind})`);
  } finally {
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
    'Local→node: POST /api/files/upload/init, 8 MiB PUT chunks with resume, then commit.',
    'Node→local: POST /api/files/download/prepare, GET content with Range resume.',
    'Node→node:  POST /n/<B>/api/transfer/grants then POST /n/<A>/api/transfer/jobs',
    '            and follow GET .../jobs/:id/events (NDJSON).',
    '',
    'Options:',
    '  -r, --recursive              copy directories',
    '  --on-conflict overwrite|skip|rename   default skip (rename is local↔node only)',
    '  --progress                   stderr progress (default on a TTY; silenced by --quiet)',
    '',
    '--json streams NDJSON progress events on stdout:',
    '  {"type":"progress","phase":"upload|download|transfer|commit","bytes":n,"total":n,"pct":n}',
    '  {"type":"item","path":"rel"}',
    '  {"type":"done","path":"dst"}',
    'cp jobs ls --json → { "jobs": [ { jobId, state, fromNodeId, toNodeId, progress, items } ] }',
    '',
    'A missing session on either node exits 3: vibeterm login --node <id>.',
  ].join('\n'),
  flags: FLAGS,
  run,
};
