// 各 workspace 的单元测试（不含 apps/fe 的 Playwright e2e：其 `test` 脚本就是 e2e，单测用 `bun test src/`）。
// 逐包顺序跑，避免 gateway 全量并行时 mesh 集成用例的端口/负载 flake。
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const TARGETS: Array<{ dir: string; args: string[] }> = [
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
  { dir: 'packages/app', args: ['test', 'src'] },
  { dir: 'apps/fe', args: ['test', 'src/'] },
  { dir: 'apps/gateway', args: ['test'] },
];

let failed = false;
for (const target of TARGETS) {
  console.log(`\n== ${target.dir}: bun ${target.args.join(' ')}`);
  const result = spawnSync('bun', target.args, { cwd: join(ROOT, target.dir), stdio: 'inherit' });
  if (result.status !== 0) {
    failed = true;
    console.error(`!! ${target.dir} failed (exit ${result.status})`);
  }
}
process.exit(failed ? 1 : 0);
