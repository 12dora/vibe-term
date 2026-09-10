// `vibeterm port`：监听方 A 的映射 + 目标方 B 的放行，语义对齐 GUI 的 createPortMapping。

import { flagBool, flagString, parseArgv } from '../core/args';
import type { CliContext } from '../core/context';
import { UsageError } from '../core/errors';
import { resolveMeshId } from '../core/files-api';
import {
  createPortMapping,
  deletePortExport,
  deletePortMapping,
  listPortMaps,
  patchPortMap,
  probeListen,
  probeTarget,
} from '../core/portmap-ops';
import type { Command } from './types';

const FLAGS = {
  on: 'string',
  name: 'string',
  'listen-host': 'string',
  export: 'boolean',
} as const;

async function listenNode(
  ctx: CliContext,
  flags: ReturnType<typeof parseArgv>['flags']
): Promise<string> {
  const on = flagString(flags, 'on');
  if (on) return (await ctx.resolver.resolveNode(on)).id;
  return ctx.targetNodeId();
}

function parseTargetSpec(raw: string): { node: string; host: string; port: number } {
  const last = raw.lastIndexOf(':');
  if (last <= 0) throw new UsageError(`expected <node>:<host>:<port>, got "${raw}"`);
  const port = Number(raw.slice(last + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new UsageError(`invalid port: ${raw.slice(last + 1)}`);
  }
  const rest = raw.slice(0, last);
  const first = rest.indexOf(':');
  if (first <= 0) throw new UsageError(`expected <node>:<host>:<port>, got "${raw}"`);
  let host = rest.slice(first + 1);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) throw new UsageError(`missing host in ${raw}`);
  return { node: rest.slice(0, first), host, port };
}

async function run(ctx: CliContext, argv: string[]): Promise<number | undefined> {
  const { flags, positionals } = parseArgv(argv, FLAGS);
  const sub = positionals[0];
  if (!sub) throw new UsageError('missing port subcommand', 'try: vibeterm port --help');
  if (sub === 'map') return runMap(ctx, flags, positionals.slice(1));
  if (sub === 'ls') return runLs(ctx, flags, positionals.slice(1));
  if (sub === 'rm') return runRm(ctx, flags, positionals.slice(1));
  if (sub === 'pause' || sub === 'resume') return runPause(ctx, flags, sub, positionals.slice(1));
  if (sub === 'probe') return runProbe(ctx, positionals.slice(1));
  throw new UsageError(
    `unknown port subcommand: ${sub}`,
    'use map, ls, rm, pause, resume or probe'
  );
}

async function runMap(
  ctx: CliContext,
  flags: ReturnType<typeof parseArgv>['flags'],
  positionals: string[]
): Promise<undefined> {
  const listenPort = Number(positionals[0]);
  const spec = positionals[1];
  if (!Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535 || !spec) {
    throw new UsageError(
      'usage: vibeterm port map <listenPort> <targetNode>:<host>:<port> [--listen-host] [--name] [--on]'
    );
  }
  const target = parseTargetSpec(spec);
  const listenNodeId = await listenNode(ctx, flags);
  const targetNodeId = (await ctx.resolver.resolveNode(target.node)).id;
  await rejectSameNodeMap(ctx, listenNodeId, targetNodeId);
  const map = await createPortMapping(ctx, {
    listenNodeId,
    targetNodeId,
    listenPort,
    listenHost: flagString(flags, 'listen-host') ?? '127.0.0.1',
    targetHost: target.host,
    targetPort: target.port,
    name: flagString(flags, 'name'),
  });
  if (ctx.globals.json) ctx.out.data({ map });
  else {
    ctx.out.line(
      `${map.id}  ${map.listenHost}:${map.listenPort} → ${map.targetNodeId}:${map.targetHost}:${map.targetPort}  ${map.state}`
    );
  }
}

async function runLs(
  ctx: CliContext,
  flags: ReturnType<typeof parseArgv>['flags'],
  positionals: string[]
): Promise<undefined> {
  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
  const maps = await listPortMaps(ctx, await listenNode(ctx, flags));
  if (ctx.globals.json) {
    ctx.out.data({ maps });
    return;
  }
  ctx.out.table(maps, [
    { header: 'ID', value: (row) => row.id },
    { header: 'NAME', value: (row) => row.name || '-' },
    { header: 'LISTEN', value: (row) => `${row.listenHost}:${row.listenPort}` },
    { header: 'TARGET', value: (row) => `${row.targetHost}:${row.targetPort}` },
    { header: 'STATE', value: (row) => row.state },
    { header: 'CONNS', value: (row) => String(row.activeConnections) },
    { header: 'IN', value: (row) => String(row.bytesIn) },
    { header: 'OUT', value: (row) => String(row.bytesOut) },
  ]);
}

async function runRm(
  ctx: CliContext,
  flags: ReturnType<typeof parseArgv>['flags'],
  positionals: string[]
): Promise<undefined> {
  const id = positionals[0];
  if (!id) throw new UsageError('usage: vibeterm port rm <id> [--on <node>] [--export]');
  const nodeId = await listenNode(ctx, flags);
  if (flagBool(flags, 'export')) {
    await deletePortExport(ctx, nodeId, id);
    if (ctx.globals.json) ctx.out.data({ removed: id, exportRemoved: true });
    else ctx.out.line(`removed export ${id} on ${nodeId}`);
    return;
  }
  const result = await deletePortMapping(ctx, nodeId, id);
  if (ctx.globals.json) ctx.out.data({ removed: id, exportRemoved: result.exportRemoved });
  else
    ctx.out.line(`removed ${id}${result.exportRemoved ? '' : ' (export still present on target)'}`);
}

async function runPause(
  ctx: CliContext,
  flags: ReturnType<typeof parseArgv>['flags'],
  action: 'pause' | 'resume',
  positionals: string[]
): Promise<undefined> {
  const id = positionals[0];
  if (!id) throw new UsageError(`usage: vibeterm port ${action} <id> [--on <node>]`);
  const map = await patchPortMap(ctx, await listenNode(ctx, flags), id, {
    paused: action === 'pause',
  });
  if (ctx.globals.json) ctx.out.data({ map });
  else ctx.out.line(`${map.id}  ${map.state}`);
}

/** 网关没有同节点短路：self→self 的映射会 listening 但每条连接都 bad_signature。 */
async function rejectSameNodeMap(
  ctx: CliContext,
  listenNodeId: string,
  targetNodeId: string
): Promise<void> {
  const listenMesh = await resolveMeshId(ctx, listenNodeId);
  const targetMesh = await resolveMeshId(ctx, targetNodeId);
  if (listenNodeId === targetNodeId || listenMesh === targetMesh) {
    throw new UsageError(
      'port map cannot listen and target the same node',
      'the gateway has no same-node short-circuit; pick a different --on or target'
    );
  }
}

async function runProbe(ctx: CliContext, positionals: string[]): Promise<undefined> {
  if (positionals.length !== 1) {
    throw new UsageError('usage: vibeterm port probe <node>:<host>:<port>');
  }
  const spec = parseTargetSpec(positionals[0]);
  const nodeId = (await ctx.resolver.resolveNode(spec.node)).id;
  const [listen, target] = await Promise.all([
    probeListen(ctx, nodeId, spec.host, spec.port),
    probeTarget(ctx, nodeId, spec.host, spec.port),
  ]);
  if (ctx.globals.json) ctx.out.data({ listen, target });
  else {
    const used = listen.usedByMapId ? `  usedBy=${listen.usedByMapId}` : '';
    ctx.out.line(
      `listen  ${listen.host}:${listen.port}  free=${listen.free}  reserved=${listen.reserved}${used}`
    );
    ctx.out.line(`target  ${target.host}:${target.port}  listening=${target.listening}`);
  }
}

export const command: Command = {
  name: 'port',
  summary: 'manage port maps',
  usage: [
    'Usage: vibeterm port <map|ls|rm|pause|resume|probe> …',
    '',
    '  map <listenPort> <targetNode>:<host>:<port> [--listen-host 127.0.0.1] [--name] [--on <node>]',
    '      POST export on B, then POST /api/portmap on A with the same mapId.',
    '      If A returns 4xx, the export is deleted. 5xx/network keeps it; clean up with',
    '      `vibeterm port rm --export <mapId> --on <B>`.',
    '      --on selects the listening node A (default: entry self / --node).',
    '      Listening node == target node is rejected (no same-node short-circuit).',
    '  ls [--on <node>]            GET /api/portmap (live counters)',
    '  rm <id> [--on <node>]       DELETE map; if exportRemoved is false, DELETE export on B',
    '  rm --export <id> --on <B>   DELETE /api/portmap/exports/:id on B (indeterminate-create cleanup)',
    '  pause|resume <id> [--on]    PATCH { paused }',
    '  probe <node>:<host>:<port>  GET /api/portmap/probe and /target-probe on that node',
    '',
    '--json shapes:',
    '  map    { "map": { id, name, listenHost, listenPort, targetNodeId, targetHost, targetPort, state, activeConnections, bytesIn, bytesOut } }',
    '  ls     { "maps": [ …same… ] }',
    '  rm     { "removed": "<id>", "exportRemoved": true|false }',
    '  pause  { "map": { … } }',
    '  probe  { "listen": { host, port, free, reserved, usedByMapId }, "target": { host, port, listening } }',
  ].join('\n'),
  flags: FLAGS,
  run,
};
