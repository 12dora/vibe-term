// `vibeterm files`：根目录与 root-relative 浏览，路径文法与 GUI 一致（rootId + 绝对路径）。

import { flagBool, parseArgv } from '../core/args';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import {
  type FileEntryDto,
  type FileRootDto,
  createFileRoot,
  deleteFileRoot,
  isHiddenName,
  listDirectory,
  listFileRoots,
  reorderFileRoots,
  resolveFileRoot,
  resolveRemotePath,
  statRemote,
} from '../core/files-api';
import { parseRemoteFileRef } from '../core/files-path';
import { rawFilePath as rawQuery } from '../core/transfer-local';
import type { Command } from './types';

const FLAGS = {
  long: 'boolean',
  all: 'boolean',
  device: 'string',
  enabled: 'boolean',
  disabled: 'boolean',
} as const;

function parseSpec(positionals: string[]): ReturnType<typeof parseRemoteFileRef> {
  if (positionals.length === 2) {
    const parsed = parseRemoteFileRef(positionals[1]);
    return { ...parsed, node: positionals[0] };
  }
  if (positionals.length === 1) return parseRemoteFileRef(positionals[0]);
  throw new UsageError(
    'expected <node>:<root>/<path> or <node> <root>/<path>',
    'example: vibeterm files ls office:home/docs'
  );
}

async function run(ctx: CliContext, argv: string[]): Promise<number | undefined> {
  const { flags, positionals } = parseArgv(argv, FLAGS);
  const sub = positionals[0];
  if (!sub) throw new UsageError('missing files subcommand', 'try: vibeterm files --help');
  if (sub === 'roots') return runRoots(ctx, flags, positionals.slice(1));
  if (sub === 'ls') return runLs(ctx, flags, positionals.slice(1));
  if (sub === 'stat') return runStat(ctx, positionals.slice(1));
  if (sub === 'cat') return runCat(ctx, positionals.slice(1));
  throw new UsageError(`unknown files subcommand: ${sub}`, 'use roots, ls, stat or cat');
}

async function runRoots(
  ctx: CliContext,
  flags: ReturnType<typeof parseArgv>['flags'],
  positionals: string[]
): Promise<undefined> {
  const action = positionals[0] ?? 'ls';
  const nodeId = await ctx.targetNodeId();
  if (action === 'ls') {
    if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);
    return printRoots(ctx, await listFileRoots(ctx.http, nodeId));
  }
  if (action === 'add') return addRoot(ctx, nodeId, flags, positionals);
  if (action === 'rm') return removeRoot(ctx, nodeId, positionals[1]);
  if (action === 'order') {
    const ids = positionals.slice(1);
    if (ids.length === 0) throw new UsageError('usage: vibeterm files roots order <id> [<id>…]');
    return printRoots(ctx, await reorderFileRoots(ctx.http, nodeId, ids));
  }
  throw new UsageError(`unknown roots subcommand: ${action}`, 'use ls, add, rm or order');
}

async function addRoot(
  ctx: CliContext,
  nodeId: string,
  flags: ReturnType<typeof parseArgv>['flags'],
  positionals: string[]
): Promise<undefined> {
  const deviceRef = typeof flags.device === 'string' ? flags.device : positionals[1];
  const path = typeof flags.device === 'string' ? positionals[1] : positionals[2];
  if (!deviceRef || !path) {
    throw new UsageError(
      'usage: vibeterm files roots add <device> <abs-path>',
      'path must be absolute, e.g. /home/me/src'
    );
  }
  if (!path.startsWith('/')) throw new UsageError(`root path must be absolute: ${path}`);
  const device = await ctx.resolver.resolveDevice(nodeId, deviceRef);
  const enabled = flags.disabled === true ? false : flags.enabled !== false;
  const root = await createFileRoot(ctx.http, nodeId, { deviceId: device.id, path, enabled });
  if (ctx.globals.json) ctx.out.data({ root });
  else ctx.out.line(`${root.id}  ${root.name}  ${root.path}`);
}

async function removeRoot(
  ctx: CliContext,
  nodeId: string,
  ref: string | undefined
): Promise<undefined> {
  if (!ref) throw new UsageError('usage: vibeterm files roots rm <id|name>');
  const root = resolveFileRoot(await listFileRoots(ctx.http, nodeId), ref);
  await deleteFileRoot(ctx.http, nodeId, root.id);
  if (ctx.globals.json) ctx.out.data({ removed: root.id });
  else ctx.out.line(`removed ${root.id}`);
}

function printRoots(ctx: CliContext, roots: FileRootDto[]): undefined {
  if (ctx.globals.json) {
    ctx.out.data({ roots });
    return;
  }
  ctx.out.table(roots, [
    { header: 'ID', value: (row) => row.id },
    { header: 'NAME', value: (row) => row.name },
    { header: 'PATH', value: (row) => row.path },
    { header: 'DEVICE', value: (row) => row.deviceName ?? row.deviceId },
    { header: 'ON', value: (row) => (row.enabled ? 'yes' : 'no') },
  ]);
}

async function runLs(
  ctx: CliContext,
  flags: ReturnType<typeof parseArgv>['flags'],
  positionals: string[]
): Promise<undefined> {
  const resolved = await resolveRemotePath(ctx, parseSpec(positionals));
  const listing = await listDirectory(
    ctx.http,
    resolved.nodeId,
    resolved.root.id,
    resolved.absPath
  );
  const entries = flagBool(flags, 'all')
    ? listing.entries
    : listing.entries.filter((entry) => !isHiddenName(entry.name));
  if (listing.truncated) {
    ctx.out.warn('listing truncated at 2000 entries (server cap; no cursor to page further)');
  }
  if (ctx.globals.json) {
    ctx.out.data({
      node: resolved.nodeId,
      root: { id: resolved.root.id, name: resolved.root.name, path: resolved.root.path },
      path: listing.path,
      truncated: listing.truncated,
      entries,
    });
    return;
  }
  if (flagBool(flags, 'long')) printLong(ctx, entries);
  else {
    for (const entry of entries) {
      ctx.out.line(entry.type === 'dir' ? `${entry.name}/` : entry.name);
    }
  }
}

function printLong(ctx: CliContext, entries: FileEntryDto[]): void {
  ctx.out.table(entries, [
    { header: 'TYPE', value: (row) => row.type },
    { header: 'SIZE', value: (row) => (row.size == null ? '-' : String(row.size)) },
    { header: 'MODIFIED', value: (row) => row.modifiedAt ?? '-' },
    { header: 'NAME', value: (row) => row.name },
  ]);
}

async function runStat(ctx: CliContext, positionals: string[]): Promise<undefined> {
  const resolved = await resolveRemotePath(ctx, parseSpec(positionals));
  const stat = await statRemote(ctx.http, resolved.nodeId, resolved.root.id, resolved.absPath);
  if (ctx.globals.json) {
    ctx.out.data({ node: resolved.nodeId, rootId: resolved.root.id, ...stat });
    return;
  }
  ctx.out.line(`${stat.type}  ${stat.size}  ${stat.modifiedAt ?? '-'}  ${stat.path}`);
}

async function runCat(ctx: CliContext, positionals: string[]): Promise<undefined> {
  const resolved = await resolveRemotePath(ctx, parseSpec(positionals));
  const response = await ctx.http.fetch(
    resolved.nodeId,
    rawQuery(resolved.root.id, resolved.absPath),
    { timeoutMs: null }
  );
  await ctx.http.assertOk(resolved.nodeId, response, '/api/files/raw');
  const body = response.body;
  if (!body) {
    ctx.out.raw(new Uint8Array(await response.arrayBuffer()));
    return;
  }
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) ctx.out.raw(value);
  }
}

export const command: Command = {
  name: 'files',
  summary: 'browse files on a node',
  usage: [
    'Usage: vibeterm files <roots|ls|stat|cat> …',
    '',
    'Paths are root-relative, same as the GUI (rootId + absolute path under the hood):',
    '  <node>:<rootId>:<relpath>     root id (UUID) + relative or /absolute path',
    '  <node>:<rootName>/<relpath>   root display name + relative path',
    '  <rootName>/<relpath>          uses --node or the entry itself',
    '  <rootId>:  or  <rootName>:    trailing colon = the root itself',
    '  fs-root:/abs/path             virtual root when the node has no enabled roots',
    'A root whose display name is "/" must be addressed by id: <rootId>:<relpath>.',
    '".." path segments are rejected client-side.',
    '',
    'Subcommands:',
    '  roots [--node]                         list file roots',
    '  roots add <device> <abs-path>          POST /api/files/roots',
    '  roots rm <id|name>                     DELETE /api/files/roots/:id',
    '  roots order <id> [<id>…]               PUT /api/files/roots/order',
    '  ls <spec> [--long] [--all]             GET /api/files/list (caps at 2000 entries)',
    '  stat <spec>                            GET /api/files/stat',
    '  cat <spec>                             GET /api/files/raw (binary to stdout)',
    '',
    '--json shapes:',
    '  roots  { "roots": [ { id, name, path, deviceId, deviceName, enabled, sortOrder } ] }',
    '  ls     { node, root, path, truncated, entries: [ { name, path, type, size, modifiedAt } ] }',
    '  stat   { node, rootId, path, name, type, size, modifiedAt, mime, isSymlink }',
    '  cat    raw bytes on stdout (ignores --json)',
    '',
    'Exit 3 if the node needs login, 4 if the root or path is missing.',
  ].join('\n'),
  flags: FLAGS,
  run,
};
