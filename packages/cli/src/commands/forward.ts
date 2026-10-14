// `vibeterm forward`：ssh -L/-R 风格的端口转发，建立在端口映射之上。
// 授权沿用映射的放行行（目标节点只放行 fromNode + host + port），等价 sshd 的 PermitOpen / PermitListen。

import { flagBool, flagString, flagStrings, parseArgv } from '../core/args';
import type { CliContext } from '../core/context';
import { InterruptError, NotFoundError, UsageError, errorText } from '../core/errors';
import { resolveMeshId } from '../core/files-api';
import { ephemeralForwardName, isReclaimableForward } from '../core/forward-names';
import {
  type ForwardSpec,
  formatHostPort,
  parseForwardSpec,
  rewriteForwardArgv,
} from '../core/forward-spec';
import {
  type CreatePortMapInput,
  type CreatedPortMap,
  type PortMapDto,
  createPortMappingDetailed,
  deletePortExport,
  deletePortMapping,
  listPortMaps,
  patchPortMap,
  renewPortExportLease,
} from '../core/portmap-ops';
import type { Command } from './types';

const FLAGS = {
  local: 'strings',
  remote: 'strings',
  persist: 'boolean',
  name: 'string',
} as const;

/** 前台转发的巡检与续约间隔；租约取 3 个间隔，容忍两次续约失败。 */
export const FORWARD_POLL_MS = 30_000;
export const FORWARD_LEASE_MS = 90_000;

export interface ForwardEntry {
  spec: ForwardSpec;
  listenNodeId: string;
  targetNodeId: string;
  /** 远端一侧的节点名，用于展示。 */
  nodeName: string;
  map: PortMapDto;
  /** 监听行 / 放行行是否带租约（网关返回了 leaseExpiresAt）；前台转发据此续约。 */
  mapLeased?: boolean;
  exportLeased?: boolean;
}

interface ForwardPlan {
  spec: ForwardSpec;
  input: CreatePortMapInput;
}

function describeEnds(spec: ForwardSpec, nodeName: string): { listen: string; target: string } {
  const listen = formatHostPort(spec.bindHost, spec.port);
  const target = formatHostPort(spec.host, spec.hostPort);
  return spec.kind === 'L'
    ? { listen, target: `${nodeName} ${target}` }
    : { listen: `${nodeName} ${listen}`, target };
}

export function describeForward(entry: ForwardEntry): string {
  const ends = describeEnds(entry.spec, entry.nodeName);
  return `转发 ${ends.listen} → ${ends.target}`;
}

function collectSpecs(flags: ReturnType<typeof parseArgv>['flags']): ForwardSpec[] {
  const specs = [
    ...flagStrings(flags, 'local').map((raw) => parseForwardSpec('L', raw)),
    ...flagStrings(flags, 'remote').map((raw) => parseForwardSpec('R', raw)),
  ];
  if (specs.length === 0) {
    throw new UsageError(
      '至少需要一个 -L 或 -R 转发规格',
      '例: vibeterm forward -L 8080:127.0.0.1:80 <node>'
    );
  }
  const seen = new Set<string>();
  for (const spec of specs) {
    const key = `${spec.kind}:${spec.bindHost}:${spec.port}`;
    if (seen.has(key)) {
      throw new UsageError(`重复的监听端口: -${spec.kind} ${spec.bindHost}:${spec.port}`);
    }
    seen.add(key);
  }
  return specs;
}

function forwardName(
  spec: ForwardSpec,
  options: { persist: boolean; name: string | undefined; count: number }
): string {
  const tag = `${spec.kind}${spec.port}`;
  if (!options.persist) return ephemeralForwardName(spec.kind, spec.port);
  if (!options.name) return `fwd:${tag}`;
  return options.count > 1 ? `${options.name}-${tag}` : options.name;
}

async function assertDistinctNodes(ctx: CliContext, here: string, other: string): Promise<void> {
  const [hereMesh, otherMesh] = await Promise.all([
    resolveMeshId(ctx, here),
    resolveMeshId(ctx, other),
  ]);
  if (here === other || hereMesh === otherMesh) {
    throw new UsageError(
      '转发目标不能是入口节点自身',
      '本机端口转发请直接使用 ssh -L；forward 用于在两个不同节点之间转发'
    );
  }
}

function isPortInUse(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as { code?: string }).code === 'port_in_use' || /port_in_use/.test(error.message);
}

async function findStale(
  ctx: CliContext,
  input: CreatePortMapInput
): Promise<PortMapDto | undefined> {
  const targetMesh = await resolveMeshId(ctx, input.targetNodeId);
  const maps = await listPortMaps(ctx, input.listenNodeId);
  return maps.find(
    (map) =>
      isReclaimableForward(map.name) &&
      map.listenHost === input.listenHost &&
      map.listenPort === input.listenPort &&
      map.targetHost === input.targetHost &&
      map.targetPort === input.targetPort &&
      (map.targetNodeId === targetMesh || map.targetNodeId === input.targetNodeId)
  );
}

async function createWithStaleRetry(
  ctx: CliContext,
  input: CreatePortMapInput
): Promise<CreatedPortMap> {
  try {
    return await createPortMappingDetailed(ctx, input);
  } catch (error) {
    if (!isPortInUse(error)) throw error;
    const stale = await findStale(ctx, input).catch(() => undefined);
    if (!stale) throw error;
    ctx.out.info(`清理上次遗留的转发 ${stale.id}`);
    await deletePortMapping(ctx, input.listenNodeId, stale.id);
    return createPortMappingDetailed(ctx, input);
  }
}

async function removeEntry(ctx: CliContext, entry: ForwardEntry): Promise<string | null> {
  try {
    await deletePortMapping(ctx, entry.listenNodeId, entry.map.id);
    return null;
  } catch (error) {
    if (!(error instanceof NotFoundError)) return errorText(error);
    try {
      await deletePortExport(ctx, entry.targetNodeId, entry.map.id);
      return null;
    } catch (exportError) {
      return errorText(exportError);
    }
  }
}

/** 逆序撤销已建立的转发（映射 + 目标侧放行）；失败逐条告警并给出手动命令，返回失败条数。 */
export async function cleanupForwards(
  ctx: CliContext,
  entries: readonly ForwardEntry[]
): Promise<number> {
  let failed = 0;
  for (const entry of [...entries].reverse()) {
    const problem = await removeEntry(ctx, entry);
    if (problem === null) continue;
    failed += 1;
    ctx.out.warn(
      `撤销 ${describeForward(entry)} 失败（${problem}）；手动清理: vibeterm port rm ${entry.map.id} --on ${entry.listenNodeId}`
    );
  }
  return failed;
}

/** 逐条建立；收到中断信号后不再建立后续转发，已建立的由调用方撤销。 */
async function createAll(
  ctx: CliContext,
  plans: readonly ForwardPlan[],
  nodeName: string,
  signal?: AbortSignal
) {
  const entries: ForwardEntry[] = [];
  try {
    for (const plan of plans) {
      if (signal?.aborted) break;
      const created = await createWithStaleRetry(ctx, plan.input);
      entries.push({
        spec: plan.spec,
        listenNodeId: plan.input.listenNodeId,
        targetNodeId: plan.input.targetNodeId,
        nodeName,
        map: created.map,
        mapLeased: created.map.leaseExpiresAt !== undefined,
        exportLeased: created.exported.leaseExpiresAt !== undefined,
      });
    }
  } catch (error) {
    if (entries.length > 0) await cleanupForwards(ctx, entries);
    throw error;
  }
  return entries;
}

function stateOf(map: PortMapDto | undefined): string {
  if (!map) return 'gone';
  if (map.state === 'listening') return 'ok';
  return map.state === 'error' ? `error:${map.error ?? 'bind_failed'}` : map.state;
}

function problemText(state: string): string {
  if (state === 'gone') return '映射已不存在';
  if (state === 'unreachable') return '无法查询映射状态';
  if (state === 'paused') return '映射已暂停';
  if (state === 'error:port_in_use') return '端口被占用';
  return state.startsWith('error:') ? `监听异常（${state.slice(6)}）` : state;
}

/** 轮询一次：状态变化时输出告警 / 恢复提示，`last` 记录各转发上次的状态。 */
export async function pollForwards(
  ctx: CliContext,
  entries: readonly ForwardEntry[],
  last: Map<string, string>
): Promise<void> {
  const byNode = new Map<string, PortMapDto[] | null>();
  for (const entry of entries) {
    if (byNode.has(entry.listenNodeId)) continue;
    byNode.set(entry.listenNodeId, await listPortMaps(ctx, entry.listenNodeId).catch(() => null));
  }
  for (const entry of entries) {
    const maps = byNode.get(entry.listenNodeId) ?? null;
    const state = maps === null ? 'unreachable' : stateOf(maps.find((m) => m.id === entry.map.id));
    const previous = last.get(entry.map.id) ?? 'ok';
    last.set(entry.map.id, state);
    if (state === previous) continue;
    if (state === 'ok') ctx.out.info(`${describeForward(entry)} 已恢复`);
    else ctx.out.warn(`${describeForward(entry)} ${problemText(state)}`);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/** 续约失败每条只提示一次，成功后重新计数；失败不致命，下个间隔会重试。 */
export async function renewForwardLeases(
  ctx: CliContext,
  entries: readonly ForwardEntry[],
  leaseMs: number,
  failing: Set<string>
): Promise<void> {
  const attempt = async (key: string, label: string, run: () => Promise<unknown>) => {
    try {
      await run();
      failing.delete(key);
    } catch (error) {
      if (failing.has(key)) return;
      failing.add(key);
      ctx.out.warn(`${label}续约失败（${errorText(error)}），将在下个间隔重试`);
    }
  };
  const tasks: Array<Promise<void>> = [];
  for (const entry of entries) {
    const id = entry.map.id;
    if (entry.mapLeased) {
      const run = () => patchPortMap(ctx, entry.listenNodeId, id, { leaseMs });
      tasks.push(attempt(`map:${id}`, `${describeForward(entry)} 监听行`, run));
    }
    if (entry.exportLeased) {
      const run = () => renewPortExportLease(ctx, entry.targetNodeId, id, leaseMs);
      tasks.push(attempt(`export:${id}`, `${describeForward(entry)} 放行行`, run));
    }
  }
  await Promise.all(tasks);
}

/** 前台守候：每个间隔先续约再巡检映射状态，直到 signal 触发。 */
export async function holdForwards(
  ctx: CliContext,
  entries: readonly ForwardEntry[],
  options: { signal: AbortSignal; pollMs?: number; leaseMs?: number }
): Promise<void> {
  const last = new Map<string, string>();
  const failing = new Set<string>();
  const pollMs = options.pollMs ?? FORWARD_POLL_MS;
  const leaseMs = options.leaseMs ?? FORWARD_LEASE_MS;
  while (!options.signal.aborted) {
    await sleep(pollMs, options.signal);
    if (options.signal.aborted) break;
    await renewForwardLeases(ctx, entries, leaseMs, failing).catch(() => undefined);
    await pollForwards(ctx, entries, last).catch(() => undefined);
  }
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** 首个信号 → abort；清理期间再来一个 → 放弃等待并以 130 退出。 */
function installSignals(): {
  signal: AbortSignal;
  forced: Promise<never>;
  dispose: () => void;
} {
  const controller = new AbortController();
  let force: (error: Error) => void = () => undefined;
  const forced = new Promise<never>((_, reject) => {
    force = reject;
  });
  forced.catch(() => undefined);
  const onSignal = (): void => {
    if (controller.signal.aborted) force(new InterruptError());
    else controller.abort();
  };
  for (const name of SIGNALS) process.on(name, onSignal);
  return {
    signal: controller.signal,
    forced,
    dispose: () => {
      for (const name of SIGNALS) process.off(name, onSignal);
    },
  };
}

function printPersistHint(ctx: CliContext, entries: readonly ForwardEntry[]): void {
  const remote = entries.find((entry) => entry.spec.kind === 'R');
  const on = remote ? `（-R 的映射位于 ${remote.nodeName}，加 --on ${remote.nodeName}）` : '';
  ctx.out.info(
    `已持久化，网关重启、链路断开后自动恢复。管理: vibeterm port ls / port rm <id>${on}`
  );
}

function reportCreated(ctx: CliContext, entries: readonly ForwardEntry[]): void {
  if (ctx.globals.json) {
    ctx.out.data({
      forwards: entries.map((entry) => ({
        direction: entry.spec.kind,
        listenNode: entry.listenNodeId,
        targetNode: entry.targetNodeId,
        map: entry.map,
      })),
    });
    return;
  }
  for (const entry of entries) ctx.out.info(describeForward(entry));
}

function buildPlans(
  specs: readonly ForwardSpec[],
  ends: { here: string; remote: string },
  options: { persist: boolean; name: string | undefined }
): ForwardPlan[] {
  return specs.map((spec) => ({
    spec,
    input: {
      listenNodeId: spec.kind === 'L' ? ends.here : ends.remote,
      targetNodeId: spec.kind === 'L' ? ends.remote : ends.here,
      listenHost: spec.bindHost,
      listenPort: spec.port,
      targetHost: spec.host,
      targetPort: spec.hostPort,
      name: forwardName(spec, { ...options, count: specs.length }),
      ...(options.persist ? {} : { leaseMs: FORWARD_LEASE_MS }),
    },
  }));
}

/** 网关没回 leaseExpiresAt = 版本较旧、忽略了租约：转发不会自动回收，只提示一次。 */
function warnOldGateways(ctx: CliContext, entries: readonly ForwardEntry[]): void {
  const old = new Set<string>();
  for (const entry of entries) {
    const listenSide = entry.spec.kind === 'L' ? '本机' : entry.nodeName;
    const targetSide = entry.spec.kind === 'L' ? entry.nodeName : '本机';
    if (!entry.mapLeased) old.add(listenSide);
    if (!entry.exportLeased) old.add(targetSide);
  }
  if (old.size === 0) return;
  ctx.out.warn(
    `${[...old].join('、')} 的网关版本较旧，不支持转发租约：转发会一直保留到被撤销，异常退出后需 vibeterm port rm 手动清理`
  );
}

async function holdUntilSignal(
  ctx: CliContext,
  entries: readonly ForwardEntry[],
  signals: { signal: AbortSignal; forced: Promise<never> }
): Promise<void> {
  warnOldGateways(ctx, entries);
  ctx.out.info('转发已就绪，按 Ctrl-C 结束并撤销');
  await holdForwards(ctx, entries, { signal: signals.signal });
  await Promise.race([cleanupForwards(ctx, entries), signals.forced]);
}

async function run(ctx: CliContext, argv: string[]): Promise<number | undefined> {
  const { flags, positionals } = parseArgv(rewriteForwardArgv(argv), FLAGS);
  if (positionals.length !== 1) {
    throw new UsageError(
      '用法: vibeterm forward [-L [bind:]port:host:hostport]... [-R ...]... [--persist] <node>',
      '详见 vibeterm forward --help'
    );
  }
  const specs = collectSpecs(flags);
  const persist = flagBool(flags, 'persist');
  const name = flagString(flags, 'name');
  if (name && !persist) throw new UsageError('--name 仅用于 --persist');

  const here = await ctx.targetNodeId();
  const node = await ctx.resolver.resolveNode(positionals[0]);
  await assertDistinctNodes(ctx, here, node.id);
  const plans = buildPlans(specs, { here, remote: node.id }, { persist, name });

  const signals = persist ? null : installSignals();
  try {
    const entries = await createAll(ctx, plans, node.name, signals?.signal);
    if (signals?.signal.aborted) {
      await Promise.race([cleanupForwards(ctx, entries), signals.forced]);
      return;
    }
    reportCreated(ctx, entries);
    if (!signals) printPersistHint(ctx, entries);
    else await holdUntilSignal(ctx, entries, signals);
  } finally {
    signals?.dispose();
  }
}

const USAGE = [
  'Usage: vibeterm forward [-L [bind:]port:host:hostport]... [-R [bind:]port:host:hostport]... [--persist] [-N] <node>',
  '',
  '  -L  在入口节点（本机）监听 port，流量由 <node> 连接 host:hostport',
  '  -R  在 <node> 监听 port，流量由入口节点连接 host:hostport',
  '  bind 缺省 127.0.0.1，* 或 0.0.0.0 监听全部网卡；IPv6 写作 [::1]；可重复多个 -L / -R',
  '  -N  兼容 ssh 习惯，无作用',
  '',
  '默认前台运行：建立转发后保持，每 30 秒续约租约并巡检，异常 / 恢复时提示，Ctrl-C 撤销全部转发后退出。',
  '  转发带 90 秒租约：客户端被强杀或断网后，网关在租约到期时自动回收映射与放行（旧版网关不支持，会提示）。',
  '  --persist       建立无租约的持久端口映射后立即退出，由网关负责保活：重启与链路断开后自动恢复',
  '  --name <name>   持久映射的名称（缺省 fwd:<L|R><port>）',
  '  --json          以 JSON 输出已建立的转发',
  '',
  '授权：每条转发在目标节点创建端口映射放行，只允许来源节点访问该 host:port，',
  '其余地址一律拒绝（等价 sshd 的 PermitOpen / PermitListen）。',
  '持久转发用 `vibeterm port ls` / `vibeterm port rm <id>` 管理；-R 的映射在 <node> 上，加 `--on <node>`。',
  '同一节点（入口自身）不能互相转发。',
  '',
  '示例:',
  '  vibeterm forward -L 15432:127.0.0.1:5432 db-node         本机 15432 → db-node 上的 5432',
  '  vibeterm forward -R 8080:127.0.0.1:3000 edge --persist   edge 的 8080 → 本机 3000，常驻',
  '  vibeterm forward -L 8080:127.0.0.1:80 -R 9000:127.0.0.1:9000 lab',
].join('\n');

export const command: Command = {
  name: 'forward',
  summary: '在节点之间转发 TCP 端口（ssh -L/-R 语义）',
  usage: USAGE,
  flags: FLAGS,
  preprocessArgv: rewriteForwardArgv,
  run,
};
