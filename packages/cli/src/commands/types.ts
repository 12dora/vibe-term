// 命令契约。新增命令组：写一个文件导出 `Command`，再登记到 `src/registry.ts`。

import type { FlagSpec } from '../core/args';
import type { CliContext } from '../core/context';

export interface Command {
  /** 命令组名，即 `vibeterm <name> …` 的第一个词。 */
  name: string;
  /** 一行说明，进 `vibeterm --help` 列表。 */
  summary: string;
  /** 多行用法，进 `vibeterm <name> --help`。 */
  usage: string;
  /** 本组自己的旗标；全局旗标由 main 合并进来，不要重复声明。 */
  flags?: FlagSpec;
  /**
   * 在 `splitGlobalFlags` 之前改写本组 argv（命令名已剥掉）。
   * 用来处理「同一旗标在子命令里既是开关又是取值」这类派发层解析不了的形状。
   */
  preprocessArgv?(argv: readonly string[]): string[];
  /**
   * 声明后，命令名确定之后、`run` 之前的失败（旗标 / --timeout / TLS 初始化）由派发层按
   * `errorPrefix: 原因` 打印并以此退出码返回，而不是走 main 的通用 `vibeterm:` / 错误类退出码。
   * `run` 内部抛出的错误仍由命令自己处理。
   */
  failureExitCode?: number;
  /** 与 `failureExitCode` 配套的错误前缀，默认 `vibeterm`。 */
  errorPrefix?: string;
  /** 返回值即退出码；返回 undefined 视为 0。抛 CliError 由 main 翻译成退出码与提示。 */
  run(ctx: CliContext, argv: string[]): Promise<number | undefined>;
}

export type CommandModule = { command: Command };
