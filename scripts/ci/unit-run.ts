// 执行器：串行（CI 默认，输出直通终端）或并行（--jobs / testq 授权），并记录每个目标的结果。
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { targetLabel } from './unit-select';
import { ROOT, type TestTarget, testFilesOf } from './unit-targets';

export type UnitResult = TestTarget & { exitCode: number; durationMs: number };
export type RunRecord = { at: string; jobs: number; results: UnitResult[] };

export const RECORD_PATH = join(ROOT, 'node_modules/.cache/vibeterm-unit/last.json');
const PROGRESS_EVERY = 25;

type Outcome = { code: number; output: string };

function runBun(unit: TestTarget, capture: boolean): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn('bun', unit.args, {
      cwd: join(ROOT, unit.dir),
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.stderr?.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', (err) => resolve({ code: 1, output: String(err) }));
    child.on('close', (code) =>
      resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString() })
    );
  });
}

// 串行规则：gateway 目录组失败后逐文件各重跑一次（单文件则整体重跑一次），全过视为通过。
async function runWithRetry(unit: TestTarget): Promise<number> {
  const first = (await runBun(unit, false)).code;
  if (first === 0 || !unit.retry) return first;
  const files = testFilesOf(unit);
  if (files.length <= 1) {
    console.warn(`.. ${targetLabel(unit)} 失败，隔离重跑一次`);
    return (await runBun(unit, false)).code;
  }
  console.warn(`.. ${targetLabel(unit)} 失败，逐个测试文件各重跑一次`);
  let retryFailed = false;
  for (const f of files) {
    console.log(`.. 重跑 ${unit.dir}: bun test ${f}`);
    const code = (await runBun({ ...unit, args: ['test', f] }, false)).code;
    if (code === 0) continue;
    retryFailed = true;
    console.error(`!! ${unit.dir} bun test ${f} 失败（exit ${code}）`);
  }
  return retryFailed ? first : 0;
}

async function runSerial(units: readonly TestTarget[]): Promise<UnitResult[]> {
  const results: UnitResult[] = [];
  for (const unit of units) {
    console.log(`\n== ${targetLabel(unit)}`);
    const t0 = Date.now();
    const exitCode = await runWithRetry(unit);
    if (exitCode !== 0) console.error(`!! ${targetLabel(unit)} 失败（exit ${exitCode}）`);
    results.push({ ...unit, exitCode, durationMs: Date.now() - t0 });
  }
  return results;
}

// 第一轮并行（输出缓存，仅失败时打印）；失败的目标在第二轮串行重跑一次，区分并发干扰与真失败，以第二轮为准。
async function runParallel(units: readonly TestTarget[], jobs: number): Promise<UnitResult[]> {
  const results: UnitResult[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < units.length) {
      const i = next++;
      const t0 = Date.now();
      const { code, output } = await runBun(units[i], true);
      results[i] = { ...units[i], exitCode: code, durationMs: Date.now() - t0 };
      done++;
      if (code !== 0) console.error(`!! 并行失败 ${targetLabel(units[i])}\n${output}`);
      else if (done % PROGRESS_EVERY === 0) console.log(`.. 已完成 ${done}/${units.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, units.length) }, worker));
  for (const [i, unit] of units.entries()) {
    if (results[i].exitCode === 0) continue;
    console.log(`\n== 串行重跑 ${targetLabel(unit)}`);
    const t0 = Date.now();
    const { code } = await runBun(unit, false);
    const durationMs = results[i].durationMs + Date.now() - t0;
    results[i] = { ...unit, exitCode: code, durationMs };
    console.log(code === 0 ? '.. 通过（并行干扰）' : `!! 仍失败（exit ${code}）`);
  }
  return results;
}

export function unitKey(unit: Pick<TestTarget, 'dir' | 'args'>): string {
  return [unit.dir, ...unit.args].join('\0');
}

// 按上次耗时从长到短调度（无记录的视为最长），减少并行长尾。
export function orderByDuration(units: readonly TestTarget[], prev?: RunRecord): TestTarget[] {
  const ms = new Map((prev?.results ?? []).map((r) => [unitKey(r), r.durationMs]));
  const weight = (u: TestTarget) => ms.get(unitKey(u)) ?? Number.POSITIVE_INFINITY;
  return [...units].sort((a, b) => {
    const [wa, wb] = [weight(a), weight(b)];
    return wa === wb ? 0 : wb > wa ? 1 : -1;
  });
}

export async function runUnits(units: readonly TestTarget[], jobs: number): Promise<UnitResult[]> {
  return jobs > 1 ? runParallel(units, jobs) : runSerial(units);
}

export function readRecord(path = RECORD_PATH): RunRecord | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunRecord;
  } catch {
    return undefined;
  }
}

export function writeRecord(record: RunRecord, path = RECORD_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

// 只重跑了部分目标时，用新结果覆盖同键旧结果，其余旧结果保留。
export function mergeRecord(prev: RunRecord | undefined, next: RunRecord): RunRecord {
  const byKey = new Map((prev?.results ?? []).map((r) => [unitKey(r), r]));
  for (const r of next.results) byKey.set(unitKey(r), r);
  return { ...next, results: [...byKey.values()] };
}

export function failedUnits(record: RunRecord): TestTarget[] {
  return record.results
    .filter((r) => r.exitCode !== 0)
    .map(({ dir, args, retry }) => (retry ? { dir, args, retry } : { dir, args }));
}
