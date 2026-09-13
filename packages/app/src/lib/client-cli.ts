// `vibeterm login|api|term|…` 这些**客户端**命令由 `@vibeterm/cli` 的 bundle 实现，
// 本文件只负责找到它并在**当前进程内**调起（保住 TTY，也省一次进程启动）。
//
// 与 `auth-spawn.ts` 的区别：那边的命令要读本机安装的库与密钥，必须用 bun 起独立运行时；
// 这边的命令只走 HTTP/WS，且刻意与 Node 兼容，直接 import 即可。

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 路由到客户端 bundle 的命令组。名单必须与 `packages/cli/src/registry.ts` 逐字一致：
 * 这里多一个会得到「unknown command」，少一个会被 packages/app 当成自己的命令报错。
 */
export const CLIENT_CLI_COMMANDS: ReadonlySet<string> = new Set([
  'login',
  'logout',
  'whoami',
  'api',
  'nodes',
  'devices',
  'tmux',
  'term',
  'files',
  'cp',
  'port',
  'share',
  'watch',
  'agent',
  'settings',
]);

export function isClientCliCommand(command: string | null | undefined): boolean {
  return Boolean(command) && CLIENT_CLI_COMMANDS.has(command as string);
}

interface ClientCliModule {
  runCli?: (argv: string[]) => Promise<number>;
}

/**
 * 四种布局的候选路径（按优先级）：
 *   1. 打包产物同级：`<pkg>/dist/cli.js` 与安装版 `<installDir>/current/cli/dist/cli.js`
 *   2. 从 `src/` 跑时的包内产物：`<pkg>/dist/cli.js`
 *   3. 开发态的 `packages/cli/dist/cli.js`
 *   4. 开发态源码 `packages/cli/src/main.ts`（只有 bun 能直接跑 .ts）
 */
export function clientCliCandidates(moduleDir: string, runtimeIsBun: boolean): string[] {
  const candidates = [
    join(moduleDir, 'cli.js'),
    resolve(moduleDir, '..', 'dist', 'cli.js'),
    resolve(moduleDir, '..', '..', 'cli', 'dist', 'cli.js'),
    resolve(moduleDir, '..', '..', '..', 'cli', 'dist', 'cli.js'),
  ];
  if (runtimeIsBun) {
    candidates.push(
      resolve(moduleDir, '..', '..', 'cli', 'src', 'main.ts'),
      resolve(moduleDir, '..', '..', '..', 'cli', 'src', 'main.ts')
    );
  }
  return candidates;
}

function runtimeIsBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

export function resolveClientCliPath(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env.VIBETERM_CLI_BUNDLE?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`VIBETERM_CLI_BUNDLE does not exist: ${override}`);
    }
    return override;
  }
  const candidates = clientCliCandidates(moduleDir, runtimeIsBun());
  const found = candidates.find((path) => existsSync(path));
  if (found) return found;
  throw new Error(
    `client cli bundle not found (looked in: ${candidates.join(', ')}). run: bun run --filter @vibeterm/cli build`
  );
}

/** 调起客户端命令；返回值即退出码。 */
export async function runClientCli(
  argv: string[],
  options: { path?: string } = {}
): Promise<number> {
  const path = options.path ?? resolveClientCliPath();
  const module = (await import(pathToFileURL(path).href)) as ClientCliModule;
  if (typeof module.runCli !== 'function') {
    throw new Error(`client cli bundle is missing runCli(): ${path}`);
  }
  return await module.runCli(argv);
}
