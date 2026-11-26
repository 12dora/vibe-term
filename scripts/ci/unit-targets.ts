// 各 workspace 的单元测试目标（不含 apps/fe 的 Playwright e2e：其 `test` 脚本就是 e2e，单测用 `bun test src/`）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type TestTarget = { dir: string; args: string[]; retry?: boolean };

export const ROOT = join(import.meta.dir, '..', '..');
export const GATEWAY = 'apps/gateway';

export const TARGETS: TestTarget[] = [
  { dir: 'packages/shared', args: ['test'] },
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
  { dir: '.', args: ['test', 'scripts/release'] },
  { dir: '.', args: ['test', 'scripts/ci'] },
];

// gateway 全量在一个进程里跑时，跨文件共享的 sqlite/端口/RTC 状态会互相打扰（closed database、
// DC 握手超时），本地实测 4 条 flake 隔离复跑全过。按 src 一级目录分进程跑，失败的目录单独重跑一次。
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

export function listTestFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.test\.tsx?$/.test(f) && !f.includes('node_modules'))
    .map((f) => f.replace(/\\/g, '/'));
}

// 目标覆盖的测试文件（相对 target.dir）。
export function testFilesOf(target: TestTarget): string[] {
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

// bun 的 mock.module 是进程级且不可撤销：含它的测试文件必须各自独立进程跑，其余文件合跑一次。
export function expand(target: TestTarget): TestTarget[] {
  const [cmd, scope = ''] = target.args;
  if (cmd !== 'test') return [target];
  const base = join(ROOT, target.dir, scope);
  if (!existsSync(base) || !statSync(base).isDirectory()) return [target];
  const files = listTestFiles(base).map((f) => join(scope, f));
  const isolated = files.filter((f) =>
    readFileSync(join(ROOT, target.dir, f), 'utf8').includes('mock.module(')
  );
  if (isolated.length === 0) return [target];
  const shared = files.filter((f) => !isolated.includes(f));
  const out: TestTarget[] = [];
  if (shared.length > 0) out.push({ ...target, args: ['test', ...shared] });
  for (const f of isolated) out.push({ ...target, args: ['test', f] });
  return out;
}

// 并行模式：gateway 目录组拆成每文件一个进程，消掉 src/mesh 这类长尾。
export function expandParallel(target: TestTarget): TestTarget[] {
  if (!target.retry) return expand(target);
  const files = testFilesOf(target);
  return files.length > 0 ? files.map((f) => ({ ...target, args: ['test', f] })) : [target];
}
