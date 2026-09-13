// `vibeterm system info`：合并 /api/system/info 与 /api/system/facts。

import { type SubHandler, emit, rejectExtra, runSubs, yn } from '../core/cmd';
import type { CliContext } from '../core/context';
import type { Command } from './types';

const FLAGS = {} as const;

const USAGE = `用法：
  vibeterm system info [--node <node>] [--json]

合并 GET /api/system/info 与 GET /api/system/facts。nodes show 仍只展示 mesh/reach。
人读为 key  value 行：os/arch/kernel、cpu、mem、disk /、disk $HOME、tmux、docker、
deployment、memory profile、version。`;

interface SystemFacts {
  hostname?: string;
  os?: string;
  arch?: string;
  kernel?: string;
  uptimeSec?: number;
  cpu?: { count?: number; load1?: number; load5?: number; load15?: number };
  mem?: { totalBytes?: number; freeBytes?: number; availableBytes?: number };
  disk?: {
    root?: { path: string; totalBytes: number; freeBytes: number } | null;
    home?: { path: string; totalBytes: number; freeBytes: number } | null;
  };
  tmux?: { healthy?: boolean; serverVersion?: string; clientVersion?: string; reason?: string };
  docker?: { present?: boolean; socket?: boolean };
  install?: { deployment?: string; installDir?: string; cliVersion?: string };
  memoryProfile?: string;
  ports?: unknown;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function formatLoad(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-';
  return value.toFixed(2);
}

function diskLine(
  label: string,
  disk: { path: string; totalBytes: number; freeBytes: number } | null | undefined
): [string, string] {
  if (!disk) return [label, '-'];
  return [label, `${formatBytes(disk.totalBytes)} total, ${formatBytes(disk.freeBytes)} free`];
}

function tmuxLine(tmux: SystemFacts['tmux']): string {
  if (!tmux) return '-';
  if (tmux.healthy) {
    const server = tmux.serverVersion ?? '-';
    const client = tmux.clientVersion ?? '-';
    return `healthy  ${server} / ${client}`;
  }
  return `unhealthy${tmux.reason ? `  ${tmux.reason}` : ''}`;
}

function dockerLine(docker: SystemFacts['docker']): string {
  if (!docker) return '-';
  if (!docker.present) return 'no';
  return `present  socket=${yn(docker.socket)}`;
}

function cpuLine(cpu: SystemFacts['cpu']): string {
  if (!cpu) return '-';
  return `${cpu.count ?? '-'}  load ${formatLoad(cpu.load1)} ${formatLoad(cpu.load5)} ${formatLoad(cpu.load15)}`;
}

function memLine(mem: SystemFacts['mem']): string {
  if (!mem) return '-';
  return `${formatBytes(mem.totalBytes)} total, ${formatBytes(mem.freeBytes)} free`;
}

function printFacts(ctx: CliContext, info: Record<string, unknown>, facts: SystemFacts): void {
  const rows: Array<[string, string]> = [
    ['os', String(facts.os ?? '-')],
    ['arch', String(facts.arch ?? '-')],
    ['kernel', String(facts.kernel ?? '-')],
    ['hostname', String(facts.hostname ?? '-')],
    ['cpu', cpuLine(facts.cpu)],
    ['mem', memLine(facts.mem)],
    diskLine('disk /', facts.disk?.root),
    diskLine('disk $HOME', facts.disk?.home),
    ['tmux', tmuxLine(facts.tmux)],
    ['docker', dockerLine(facts.docker)],
    ['deployment', String(facts.install?.deployment ?? info.deployment ?? '-')],
    ['memory profile', String(facts.memoryProfile ?? '-')],
    ['version', String(info.version ?? facts.install?.cliVersion ?? '-')],
  ];
  const width = Math.max(...rows.map((row) => row[0].length));
  for (const [key, value] of rows) {
    ctx.out.line(`${key.padEnd(width)}  ${value}`);
  }
}

async function fetchFacts(ctx: CliContext, nodeId: string): Promise<SystemFacts> {
  const response = await ctx.http.fetch(nodeId, '/api/system/facts');
  if (response.status === 404) {
    ctx.out.warn('GET /api/system/facts is not available on this node');
    return {};
  }
  await ctx.http.assertOk(nodeId, response, '/api/system/facts');
  return (await response.json()) as SystemFacts;
}

const info: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const nodeId = await ctx.targetNodeId();
  const infoBody = await ctx.http.json<Record<string, unknown>>(nodeId, 'GET', '/api/system/info');
  const facts = await fetchFacts(ctx, nodeId);
  const merged = { ...infoBody, ...facts };
  emit(ctx, merged, () => printFacts(ctx, infoBody, facts));
};

const HANDLERS: Record<string, SubHandler> = { info };

async function run(ctx: CliContext, argv: string[]): Promise<number | undefined> {
  return runSubs(ctx, argv, FLAGS, HANDLERS, 'known: info');
}

export const command: Command = {
  name: 'system',
  summary: '查看节点主机信息（系统、内存、磁盘、tmux、docker）',
  usage: USAGE,
  flags: FLAGS,
  run,
};
