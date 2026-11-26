// --changed 选择：改动文件 → 所属依赖图节点（workspace 包或仓库根测试目录）→ 该节点及其（传递）依赖者的测试目标。
import { isPathUnder, posix, stripTestSuffix } from './unit-paths';
import { GATEWAY, type TestTarget } from './unit-targets';
import { type Workspace, dependentChains, ownerOf } from './unit-workspace';

export const FULL = 'FULL' as const;

export type Selected = { target: TestTarget; reasons: string[] };

export type SelectContext = {
  workspace: Workspace;
  // gateway src 改动文件 → 其（传递）导入者，值为最初的改动文件
  gatewayAffected: (changed: readonly string[]) => ReadonlyMap<string, string>;
};

const FULL_FILES = new Set([
  'bun.lock',
  'package.json',
  'biome.json',
  'tsconfig.json',
  'bunfig.toml',
  'scripts/test/preload.ts',
]);
// 运行器自身（unit-*.ts，不含其测试文件）：改动后无法信任增量选择。
const RUNNER_FILE = /^scripts\/ci\/unit-(?!tests\.test\.ts$)[^/]+\.ts$/;
const GATEWAY_GLOBAL = new Set(
  ['package.json', 'bunfig.toml', 'test-preload.ts', 'tsconfig.json'].map((f) => `${GATEWAY}/${f}`)
);
const MAX_REASONS = 3;

export function isFullTrigger(file: string): boolean {
  return FULL_FILES.has(file) || RUNNER_FILE.test(file);
}

function isGatewayGlobal(file: string): boolean {
  return (
    GATEWAY_GLOBAL.has(file) || file.startsWith(`${GATEWAY}/drizzle`) || file === 'env/test.env'
  );
}

function scopeOf(target: TestTarget): string {
  return posix(target.args[1] ?? '').replace(/\/$/, '');
}

// 目标在依赖图中的节点：workspace 包目录；仓库根目标（dir '.'）用其限定的目录（如 scripts/release）。
export function targetNode(target: TestTarget): string {
  return target.dir === '.' ? scopeOf(target) : target.dir;
}

// gateway 目录组由 args[1] 限定范围（src 下的目录或顶层测试文件，测试文件同时匹配其被测源文件）。
function matchesGatewayScope(target: TestTarget, file: string): boolean {
  const scope = scopeOf(target);
  if (!scope || !isPathUnder(file, GATEWAY)) return false;
  const rel = file.slice(GATEWAY.length + 1);
  return isPathUnder(rel, scope) || stripTestSuffix(rel) === stripTestSuffix(scope);
}

function describeFiles(files: readonly string[]): string {
  return files.length > 1 ? `${files[0]} 等 ${files.length} 个文件` : files[0];
}

type Reasons = Map<string, string[]>;

function addReason(map: Reasons, key: string, reason: string): void {
  map.set(key, [...(map.get(key) ?? []), reason]);
}

// own：包自身有改动；viaDeps：包因依赖链上的包改动而受影响。
function packageReasons(ws: Workspace, files: readonly string[]) {
  const byPackage = new Map<string, string[]>();
  for (const file of files) {
    const pkg = ownerOf(ws, file);
    if (pkg) byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), file]);
  }
  const own: Reasons = new Map();
  const viaDeps: Reasons = new Map();
  for (const [pkg, pkgFiles] of byPackage) {
    const origin = describeFiles(pkgFiles);
    addReason(own, pkg, `${origin} → ${pkg}`);
    for (const [dir, chain] of dependentChains(ws, pkg)) {
      addReason(viaDeps, dir, `${origin} → ${chain.join(' → ')}`);
    }
  }
  return { own, viaDeps };
}

type GatewayPlan = { all: string[] } | { affected: ReadonlyMap<string, string> };

// 依赖包改动或 gateway 全局文件改动 → 所有目录组；src 内改动 → 该目录组 + 导入它的目录组。
function planGateway(
  files: readonly string[],
  ctx: SelectContext,
  viaDeps: Reasons
): GatewayPlan | undefined {
  const deps = viaDeps.get(GATEWAY);
  if (deps) return { all: deps };
  const globals = files.filter(isGatewayGlobal);
  if (globals.length > 0) return { all: globals };
  const src = files.filter((f) => isPathUnder(f, `${GATEWAY}/src`));
  return src.length > 0 ? { affected: ctx.gatewayAffected(src) } : undefined;
}

function gatewayReasons(plan: GatewayPlan | undefined, target: TestTarget): string[] {
  if (!plan) return [];
  if ('all' in plan) return plan.all;
  const byOrigin = new Map<string, string>();
  for (const [file, origin] of plan.affected) {
    if (matchesGatewayScope(target, file) && !byOrigin.has(origin)) byOrigin.set(origin, file);
  }
  return [...byOrigin].map(([origin, file]) => (origin === file ? file : `${origin} → ${file}`));
}

export function selectTargets(
  targets: readonly TestTarget[],
  changedFiles: readonly string[],
  ctx: SelectContext
): typeof FULL | Selected[] {
  const files = changedFiles.map(posix).filter(Boolean);
  if (files.length === 0) return [];
  if (files.some(isFullTrigger)) return FULL;
  const { own, viaDeps } = packageReasons(ctx.workspace, files);
  const gateway = planGateway(files, ctx, viaDeps);
  const out: Selected[] = [];
  for (const target of targets) {
    const node = targetNode(target);
    const reasons =
      target.dir === GATEWAY
        ? gatewayReasons(gateway, target)
        : [...(own.get(node) ?? []), ...(viaDeps.get(node) ?? [])];
    if (reasons.length > 0) out.push({ target, reasons });
  }
  return out;
}

export function targetLabel(target: TestTarget): string {
  const [head, ...rest] = target.args;
  const shown = rest.slice(0, 2).join(' ');
  const more = rest.length > 2 ? ` (+${rest.length - 2})` : '';
  return `${target.dir}: bun ${[head, shown].filter(Boolean).join(' ')}${more}`;
}

export function formatSelection(items: readonly Selected[]): string {
  const lines = [`共 ${items.length} 个目标：`];
  for (const { target, reasons } of items) {
    lines.push(`  ${targetLabel(target)}`);
    for (const reason of reasons.slice(0, MAX_REASONS)) lines.push(`    原因：${reason}`);
    if (reasons.length > MAX_REASONS) lines.push(`    … 另有 ${reasons.length - MAX_REASONS} 条`);
  }
  return lines.join('\n');
}
