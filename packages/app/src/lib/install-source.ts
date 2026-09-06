// 安装来源：写进 install-meta.json，网页「关于」页据此显示「安装方式」。
//
// `packages/app` 刻意不依赖 workspace 包，类型在 ../types 里单独声明（与 `@vibeterm/shared`
// 的 `InstallSource` 同一组取值，少了只有网关才判定得出的 `manual`）。

import type { InstallSource } from '../types';

/** 包管理器（npm / npx / pnpm / yarn / bunx）跑起来的进程都会带上这两个变量之一。 */
function isPackageManagerRun(env: NodeJS.ProcessEnv): boolean {
  if (/^(npm|npx|pnpm|yarn|bun)\//.test(env.npm_config_user_agent ?? '')) return true;
  return /(npm-cli\.js|npx-cli\.js|[/\\]npx$)/.test(env.npm_execpath ?? '');
}

/**
 * install.sh 会显式打标（`VIBETERM_INSTALL_SOURCE`；旧脚本用 `TMEX_INSTALL_SOURCE`），
 * 其余按包管理器变量区分 npx 与直接执行 CLI。
 */
export function detectInstallSource(env: NodeJS.ProcessEnv = process.env): InstallSource {
  const marked = env.VIBETERM_INSTALL_SOURCE ?? env.TMEX_INSTALL_SOURCE;
  if (marked === 'install.sh' || marked === 'install-script') return 'install-script';
  return isPackageManagerRun(env) ? 'npx' : 'cli';
}
