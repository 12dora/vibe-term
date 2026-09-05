/**
 * 把任意 catch 到的值收敛成一句人类可读的错误文本。
 *
 * 与 `@tmex/shared` 的 `errorMessage` 同语义，但 `packages/app` 刻意不依赖 workspace 包
 * （npm 包 `tmex-cli` 要能在没有 bun / 没有 monorepo 的机器上独立安装），故本地保留一份。
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
