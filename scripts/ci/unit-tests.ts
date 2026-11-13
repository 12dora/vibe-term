// 各 workspace 的单元测试（不含 apps/fe 的 Playwright e2e：其 `test` 脚本就是 e2e，单测用 `bun test src/`）。
// 逐包顺序跑，避免 gateway 全量并行时 mesh 集成用例的端口/负载 flake。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type TestTarget = { dir: string; args: string[]; retry?: boolean };
export const FULL = 'FULL' as const;

const ROOT = join(import.meta.dir, '..', '..');
const GATEWAY = 'apps/gateway';
const SHARED_DIR = 'packages/shared';
const SHARED_DEP = '@vibeterm/shared';
const FULL_FILES = new Set([
  'bun.lock',
  'package.json',
  'biome.json',
  'tsconfig.json',
  'scripts/ci/unit-tests.ts',
  'scripts/test/preload.ts',
]);

export const TARGETS: TestTarget[] = [
  { dir: SHARED_DIR, args: ['test'] },
  { dir: 'packages/ws-client', args: ['test'] },
  { dir: 'packages/ghostty-terminal', args: ['test'] },
  { dir: 'packages/terminal-ui', args: ['test'] },
  { dir: 'packages/stores', args: ['test'] },
  { dir: 'packages/panels', args: ['test'] },
  { dir: 'packages/ui', args: ['test'] },
  { dir: 'packages/theme', args: ['test'] },
  { dir: 'packages/api-client', args: ['test'] },
  { dir: 'packages/notifications', args: ['test'] },
  { dir: 'packages/transfer', args: ['test'] },
  { dir: 'packages/cli', args: ['test'] },
  { dir: 'packages/app', args: ['test', 'src'] },
  { dir: 'apps/fe', args: ['test', 'src/'] },
  { dir: '.', args: ['test', 'scripts/complexity'] },
];
// gateway 全量在一个进程里跑时，跨文件共享的 sqlite/端口/RTC 状态会互相打扰（closed database、
// DC 握手超时），本地实测 4 条 flake 隔离复跑全过。CI 里按 src 一级目录分进程跑，失败的目录单独重跑一次。
function hasTests(dir: string): boolean {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).some((f) =>
    /\.test\.tsx?$/.test(f)
  );
}

for (const entry of readdirSync(join(ROOT, GATEWAY, 'src'))) {
  const rel = join('src', entry);
  const isDir = statSync(join(ROOT, GATEWAY, rel)).isDirectory();
  if (isDir ? !hasTests(join(ROOT, GATEWAY, rel)) : !/\.test\.ts$/.test(entry)) continue;
  TARGETS.push({ dir: GATEWAY, args: ['test', rel], retry: true });
}

// bun 的 mock.module 是进程级且不可撤销：含它的测试文件必须各自独立进程跑，其余文件合跑一次。
function listTestFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.test\.tsx?$/.test(f) && !f.includes('node_modules'))
    .map((f) => f.replace(/\\/g, '/'));
}

function usesModuleMock(path: string): boolean {
  return readFileSync(path, 'utf8').includes('mock.module(');
}

function expand(target: TestTarget): TestTarget[] {
  const [cmd, scope = ''] = target.args;
  if (cmd !== 'test') return [target];
  const base = join(ROOT, target.dir, scope);
  if (!existsSync(base) || !statSync(base).isDirectory()) return [target];
  const files = listTestFiles(base).map((f) => join(scope, f));
  const isolated = files.filter((f) => usesModuleMock(join(ROOT, target.dir, f)));
  if (isolated.length === 0) return [target];
  const shared = files.filter((f) => !isolated.includes(f));
  const out: TestTarget[] = [];
  if (shared.length > 0) out.push({ ...target, args: ['test', ...shared] });
  for (const f of isolated) out.push({ ...target, args: ['test', f] });
  return out;
}

function testFilesOf(target: { dir: string; args: string[] }): string[] {
  const [cmd, ...scopes] = target.args;
  if (cmd !== 'test') return [];
  const out: string[] = [];
  for (const scope of scopes.length > 0 ? scopes : ['.']) {
    const abs = join(ROOT, target.dir, scope);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      out.push(
        ...listTestFiles(abs).map((f) => (scope === '.' ? f : join(scope, f).replace(/\\/g, '/')))
      );
    } else if (/\.test\.tsx?$/.test(scope)) {
      out.push(scope.replace(/\\/g, '/'));
    }
  }
  return out;
}

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

function isPathUnder(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}/`);
}

function stripTestSuffix(p: string): string {
  return p.replace(/\.test(\.tsx?)$/, '$1');
}

function isFullTrigger(file: string): boolean {
  return FULL_FILES.has(file) || isPathUnder(file, SHARED_DIR);
}

function isGatewayGlobal(file: string): boolean {
  return (
    file === `${GATEWAY}/package.json` ||
    file.startsWith(`${GATEWAY}/drizzle`) ||
    file === 'env/test.env'
  );
}

function matchesTarget(target: TestTarget, file: string): boolean {
  if (target.dir === GATEWAY) {
    const rel = posix(target.args[1] ?? '');
    if (!rel || !isPathUnder(file, GATEWAY)) return false;
    const rest = file.slice(GATEWAY.length + 1);
    if (rest === rel || rest.startsWith(`${rel}/`)) return true;
    return stripTestSuffix(rest) === stripTestSuffix(rel);
  }
  if (target.dir === '.') return isPathUnder(file, 'scripts/complexity');
  return isPathUnder(file, target.dir);
}

export function packageDependsOnShared(pkg: {
  dependencies?: Record<string, string>;
}): boolean {
  return Boolean(pkg.dependencies?.[SHARED_DEP]);
}

export function selectTargets(
  targets: readonly TestTarget[],
  changedFiles: readonly string[],
  sharedConsumers: ReadonlySet<string>
): typeof FULL | TestTarget[] {
  const files = changedFiles.map(posix).filter(Boolean);
  if (files.length === 0) return [];
  if (files.some(isFullTrigger)) return FULL;
  const gatewayAll = files.some(isGatewayGlobal);
  const chosen = new Set<TestTarget>();
  for (const target of targets) {
    if (target.dir === GATEWAY && gatewayAll) {
      chosen.add(target);
      continue;
    }
    if (files.some((f) => matchesTarget(target, f))) chosen.add(target);
  }
  if ([...chosen].some((t) => sharedConsumers.has(t.dir))) {
    const shared = targets.find((t) => t.dir === SHARED_DIR);
    if (shared) chosen.add(shared);
  }
  return targets.filter((t) => chosen.has(t));
}

export function loadSharedConsumers(): Set<string> {
  const dirs = new Set(TARGETS.map((t) => t.dir));
  const out = new Set<string>();
  for (const dir of dirs) {
    if (dir === '.' || dir === SHARED_DIR) continue;
    const pkgPath = join(ROOT, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    if (packageDependsOnShared(pkg)) out.add(dir);
  }
  return out;
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

function runSuite(targets: TestTarget[]): boolean {
  let failed = false;
  for (const target of targets.flatMap(expand)) {
    console.log(`\n== ${target.dir}: bun ${target.args.join(' ')}`);
    const run = () =>
      spawnSync('bun', target.args, { cwd: join(ROOT, target.dir), stdio: 'inherit' });
    let result = run();
    if (result.status !== 0 && target.retry) {
      const files = testFilesOf(target);
      if (files.length > 1) {
        console.warn(
          `.. ${target.dir} ${target.args.join(' ')} failed, retrying each test file once`
        );
        let retryFailed = false;
        for (const f of files) {
          console.log(`.. retry ${target.dir}: bun test ${f}`);
          const retry = spawnSync('bun', ['test', f], {
            cwd: join(ROOT, target.dir),
            stdio: 'inherit',
          });
          if (retry.status !== 0) {
            retryFailed = true;
            console.error(`!! ${target.dir} bun test ${f} failed (exit ${retry.status})`);
          }
        }
        if (!retryFailed) result = { ...result, status: 0 };
      } else {
        console.warn(
          `.. ${target.dir} ${target.args.join(' ')} failed, retrying once in isolation`
        );
        result = run();
      }
    }
    if (result.status !== 0) {
      failed = true;
      console.error(`!! ${target.dir} ${target.args.join(' ')} failed (exit ${result.status})`);
    }
  }
  return failed;
}

function main(): void {
  let selected: TestTarget[] = TARGETS;
  if (process.argv.includes('--changed')) {
    const files = collectChangedFiles();
    if (files.length === 0) {
      console.log('nothing to test');
      process.exit(0);
    }
    const picked = selectTargets(TARGETS, files, loadSharedConsumers());
    if (picked === FULL) selected = TARGETS;
    else if (picked.length === 0) {
      console.log('nothing to test');
      process.exit(0);
    } else selected = picked;
  }
  process.exit(runSuite(selected) ? 1 : 0);
}

if (import.meta.main) main();
