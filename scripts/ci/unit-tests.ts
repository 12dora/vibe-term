// 各 workspace 的单元测试入口（`bun run test:unit` / `test:changed` / `test:failed`）。
//   --changed  相对 HEAD 的改动 → 改动包及其传递依赖者的目标
//   --failed   只重跑上次失败的目标（node_modules/.cache/vibeterm-unit/last.json）
//   --list     只打印选中的目标与原因
//   --jobs N   并行度；缺省时若 PATH 上有 testq 则持有一个授权并以授权数并行，否则串行（CI）
import { spawnSync } from 'node:child_process';
import { affectedFiles, loadGatewaySources } from './unit-gateway-imports';
import {
  type RunRecord,
  failedUnits,
  mergeRecord,
  orderByDuration,
  readRecord,
  runUnits,
  writeRecord,
} from './unit-run';
import {
  FULL,
  type SelectContext,
  type Selected,
  formatSelection,
  isFullTrigger,
  selectTargets,
  targetLabel,
} from './unit-select';
import { ROOT, TARGETS, type TestTarget, expand, expandParallel } from './unit-targets';
import { loadWorkspace } from './unit-workspace';

export * from './unit-gateway-imports';
export * from './unit-paths';
export * from './unit-run';
export * from './unit-select';
export * from './unit-targets';
export * from './unit-workspace';

export type Options = { changed: boolean; failed: boolean; list: boolean; jobs?: number };

const TESTQ_ARGS = ['--want', '12', '--min', '2', '--mem-per', '600', '--label', 'vibe-term unit'];

export function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { changed: false, failed: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--changed') opts.changed = true;
    else if (arg === '--failed') opts.failed = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--jobs' || arg.startsWith('--jobs=')) {
      const raw = arg === '--jobs' ? argv[++i] : arg.slice('--jobs='.length);
      const jobs = Number(raw);
      if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs 需要正整数，收到 ${raw}`);
      opts.jobs = jobs;
    } else throw new Error(`未知参数 ${arg}`);
  }
  if (opts.changed && opts.failed) throw new Error('--changed 与 --failed 不能同时使用');
  return opts;
}

export function resolveJobs(opts: Options, env: Record<string, string | undefined>): number {
  const granted = Number(env.TESTQ_WORKERS);
  if (opts.jobs !== undefined) return opts.jobs;
  return Number.isInteger(granted) && granted >= 1 ? granted : 1;
}

export function needsTestqGrant(
  opts: Options,
  env: Record<string, string | undefined>,
  hasTestq: boolean
): boolean {
  return opts.jobs === undefined && !env.TESTQ_WORKERS && hasTestq;
}

function gitNameOnly(args: string[]): string[] {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || `git ${args.join(' ')} failed`).trim());
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function collectChangedFiles(): string[] {
  return [
    ...new Set([
      ...gitNameOnly(['diff', '--name-only', 'HEAD']),
      ...gitNameOnly(['ls-files', '--others', '--exclude-standard']),
    ]),
  ];
}

function selectionContext(): SelectContext {
  return {
    workspace: loadWorkspace(ROOT),
    gatewayAffected: (changed) => affectedFiles(loadGatewaySources(ROOT), changed),
  };
}

function everything(reason: string): Selected[] {
  return TARGETS.map((target) => ({ target, reasons: [reason] }));
}

type Plan = { items: Selected[]; note?: string; units?: TestTarget[] };

function plan(opts: Options): Plan {
  if (opts.failed) {
    const record = readRecord();
    if (!record) throw new Error('没有上次运行记录，先运行 bun run test:unit 或 test:changed');
    const units = failedUnits(record);
    return { items: units.map((target) => ({ target, reasons: ['上次运行失败'] })), units };
  }
  if (!opts.changed) return { items: everything('全量') };
  const files = collectChangedFiles();
  const picked = selectTargets(TARGETS, files, selectionContext());
  if (picked !== FULL) return { items: picked };
  const triggers = files.filter(isFullTrigger).join('、');
  return { items: everything('全量'), note: `全局文件改动，全量运行：${triggers}` };
}

function reexecUnderTestq(): never {
  const cmd = [process.execPath, process.argv[1], ...process.argv.slice(2)];
  const result = spawnSync('testq', ['run', ...TESTQ_ARGS, '--', ...cmd], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

function report(results: RunRecord['results']): boolean {
  const failed = results.filter((r) => r.exitCode !== 0);
  const seconds = Math.round(results.reduce((sum, r) => sum + r.durationMs, 0) / 1000);
  console.log(`\n完成：${results.length} 个进程，失败 ${failed.length}（累计耗时 ${seconds}s）`);
  for (const r of failed) console.error(`!! ${targetLabel(r)}（exit ${r.exitCode}）`);
  if (failed.length > 0) console.error('只重跑失败项：bun run test:failed');
  return failed.length > 0;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const { items, note, units } = plan(opts);
  if (items.length === 0) {
    console.log(opts.failed ? '上次运行没有失败目标' : '无需测试');
    return;
  }
  if (note) console.log(note);
  if (opts.list) {
    console.log(formatSelection(items));
    return;
  }
  if (needsTestqGrant(opts, process.env, Boolean(Bun.which('testq')))) reexecUnderTestq();
  const jobs = resolveJobs(opts, process.env);
  const all = units ?? items.map((i) => i.target).flatMap(jobs > 1 ? expandParallel : expand);
  const prev = readRecord();
  const results = await runUnits(jobs > 1 ? orderByDuration(all, prev) : all, jobs);
  const record: RunRecord = { at: new Date().toISOString(), jobs, results };
  writeRecord(opts.failed ? mergeRecord(prev, record) : record);
  process.exit(report(results) ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`!! ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  });
}
