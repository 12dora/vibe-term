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
  /** 返回值即退出码；返回 undefined 视为 0。抛 CliError 由 main 翻译成退出码与提示。 */
  run(ctx: CliContext, argv: string[]): Promise<number | undefined>;
}

export type CommandModule = { command: Command };
