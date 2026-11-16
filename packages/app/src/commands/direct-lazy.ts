import type { DirectEnableResult, DisableDirectOptions, EnableDirectOptions } from './direct';

/** 直连安装器（下载 / 校验 addon）只在启用 / 关闭直连时加载，不进 runtime 启动图。 */
export function loadDirectCommands() {
  return import('./direct');
}

export async function enableDirectLazily(
  options: EnableDirectOptions
): Promise<DirectEnableResult> {
  return (await loadDirectCommands()).enableDirect(options);
}

export async function disableDirectLazily(options: DisableDirectOptions): Promise<void> {
  return (await loadDirectCommands()).disableDirect(options);
}
