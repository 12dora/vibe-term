// 各 workspace 的单元测试（不含 apps/fe 的 Playwright e2e：其 `test` 脚本就是 e2e，单测用 `bun test src/`）。
// 逐包顺序跑，避免 gateway 全量并行时 mesh 集成用例的端口/负载 flake。
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const TARGETS: Array<{ dir: string; args: string[]; retry?: boolean }> = [
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
];
// gateway 全量在一个进程里跑时，跨文件共享的 sqlite/端口/RTC 状态会互相打扰（closed database、
// DC 握手超时），本地实测 4 条 flake 隔离复跑全过。CI 里按 src 一级目录分进程跑，失败的目录单独重跑一次。
const GATEWAY = 'apps/gateway';
for (const entry of readdirSync(join(ROOT, GATEWAY, 'src'))) {
  const rel = join('src', entry);
  const isDir = statSync(join(ROOT, GATEWAY, rel)).isDirectory();
  if (!isDir && !/\.test\.ts$/.test(entry)) continue;
  TARGETS.push({ dir: GATEWAY, args: ['test', rel], retry: true });
}

let failed = false;
for (const target of TARGETS) {
  console.log(`\n== ${target.dir}: bun ${target.args.join(' ')}`);
  const run = () =>
    spawnSync('bun', target.args, { cwd: join(ROOT, target.dir), stdio: 'inherit' });
  let result = run();
  if (result.status !== 0 && target.retry) {
    console.warn(`.. ${target.dir} ${target.args.join(' ')} failed, retrying once in isolation`);
    result = run();
  }
  if (result.status !== 0) {
    failed = true;
    console.error(`!! ${target.dir} ${target.args.join(' ')} failed (exit ${result.status})`);
  }
}
process.exit(failed ? 1 : 0);
