// `vibeterm` 客户端命令的入口。由 packages/app 的 `vibeterm` 分发到这里（bundle 内 import），
// 也可以直接 `node dist/cli.js <cmd>` 运行。

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setDefaultClientVersion } from '@vibeterm/ws-client';
import {
  type FlagSpec,
  GLOBAL_FLAGS,
  flagBool,
  flagNumber,
  flagString,
  splitGlobalFlags,
} from './core/args';
import { buildContext } from './core/context';
import { EXIT_OK, UsageError, errorText, exitCodeOf, hintOf } from './core/errors';
import { Output, captureDiagnostics, shouldUseColor } from './core/output';
import { COMMANDS, IMPLEMENTED_COMMANDS, RESERVED_COMMANDS, findCommand } from './registry';
import { cliVersion } from './version';

const GLOBAL_HELP = [
  'Usage: vibeterm <command> [options]',
  '',
  'Commands:',
  ...IMPLEMENTED_COMMANDS.map((command) => `  ${command.name.padEnd(10)}${command.summary}`),
  '',
  'Reserved (not implemented yet):',
  `  ${RESERVED_COMMANDS.map((command) => command.name).join(', ')}`,
  '',
  'Global options:',
  '  --entry <url>     gateway entry (default: $VIBETERM_ENTRY, last used, local install, 127.0.0.1:9883)',
  '  --node <id|name>  target node behind the entry (default: the entry itself)',
  '  --json            machine-readable output on stdout',
  '  --quiet           suppress human-facing chatter on stderr',
  '  --no-color        disable ANSI colors',
  '  --timeout <ms>    per-request timeout (default 30000)',
  '  --help, -h        show help for a command',
  '',
  'Exit codes: 0 ok, 1 error, 2 usage, 3 auth required, 4 not found, 5 network.',
  '',
  'Run "vibeterm <command> --help" for the options of one command.',
].join('\n');

/** 命令名是第一个不是旗标、也不是旗标取值的 token。 */
export function findCommandToken(argv: readonly string[]): { name: string | null; index: number } {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') break;
    if (!token.startsWith('-')) return { name: token, index };
    const key = token.startsWith('--') ? token.slice(2).split('=')[0] : '';
    const kind = GLOBAL_FLAGS[key];
    // 未知旗标先当布尔跳过：命令定下来之后由完整的 spec 报错，报错信息才准确。
    if (kind && kind !== 'boolean' && !token.includes('=')) index += 1;
  }
  return { name: null, index: -1 };
}

function mergedSpec(commandFlags: FlagSpec | undefined): FlagSpec {
  return { ...GLOBAL_FLAGS, ...commandFlags };
}

function bareOutput(argv: readonly string[]): Output {
  const noColor = argv.includes('--no-color');
  return new Output({ json: false, quiet: false, color: shouldUseColor(noColor) });
}

export async function runCli(argv: string[]): Promise<number> {
  // 网关按 clientVersion 做 canonical v1.1 版本门，建任何 WS 之前必须先注入真实版本。
  setDefaultClientVersion(cliVersion());
  const out = bareOutput(argv);
  try {
    return await dispatch(argv, out);
  } catch (error) {
    out.error(`vibeterm: ${errorText(error)}`);
    const hint = hintOf(error);
    if (hint) out.error(`  ${hint}`);
    return exitCodeOf(error);
  }
}

async function dispatch(argv: string[], out: Output): Promise<number> {
  const { name, index } = findCommandToken(argv);
  if (!name || name === 'help') {
    const requested = name === 'help' ? argv[index + 1] : undefined;
    const target = requested ? findCommand(requested) : null;
    out.line(target ? target.usage : GLOBAL_HELP);
    return EXIT_OK;
  }

  const command = findCommand(name);
  if (!command) {
    throw new UsageError(
      `unknown command: ${name}`,
      `known commands: ${COMMANDS.map((item) => item.name).join(', ')}`
    );
  }

  const rest = [...argv.slice(0, index), ...argv.slice(index + 1)];
  const { globals, rest: commandArgv } = splitGlobalFlags(rest, mergedSpec(command.flags));
  if (flagBool(globals, 'help')) {
    out.line(command.usage);
    return EXIT_OK;
  }

  const timeout = flagNumber(globals, 'timeout');
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) {
    throw new UsageError(`--timeout must be a positive integer, got ${timeout}`);
  }

  // 库里的 console.log 不能污染 stdout：命令结果（尤其 --json）独占那条通道。
  captureDiagnostics(flagBool(globals, 'quiet'));

  const ctx = buildContext({
    entryFlag: flagString(globals, 'entry'),
    node: flagString(globals, 'node') ?? null,
    json: flagBool(globals, 'json'),
    quiet: flagBool(globals, 'quiet'),
    noColor: flagBool(globals, 'no-color'),
    ...(timeout === undefined ? {} : { timeoutMs: timeout }),
  });
  const code = await command.run(ctx, commandArgv);
  return typeof code === 'number' ? code : EXIT_OK;
}

/** 直接运行（`node dist/cli.js …`）时才自动执行；被 import 时只导出 `runCli`。 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
