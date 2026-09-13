import type { Command } from './commands/types';
import {
  type FlagSpec,
  GLOBAL_FLAGS,
  flagBool,
  flagNumber,
  flagString,
  splitGlobalFlags,
} from './core/args';
import { buildContext } from './core/context';
import { EXIT_OK, UsageError } from './core/errors';
import { type Output, captureDiagnostics } from './core/output';
import { loadTlsSettings, prepareProcessTls } from './core/tls';
import { COMMANDS, findCommand } from './registry';

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

export function helpForArgv(argv: readonly string[], globalHelp: string): string | null {
  const token = findCommandToken(argv);
  if (token.name && token.name !== 'help') return null;
  const requested = token.name === 'help' ? argv[token.index + 1] : undefined;
  const target = requested ? findCommand(requested) : null;
  return target ? target.usage : globalHelp;
}

function requireCommand(name: string): Command {
  const command = findCommand(name);
  if (!command) {
    throw new UsageError(
      `unknown command: ${name}`,
      `known commands: ${COMMANDS.map((item) => item.name).join(', ')}`
    );
  }
  return command;
}

function requireTimeout(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new UsageError(`--timeout must be a positive integer, got ${timeout}`);
  }
  return timeout;
}

type PreparedCommand = {
  command: Command;
  commandArgv: string[];
  showHelp: boolean;
  timeout: number | undefined;
  ca: string | undefined;
  insecure: boolean;
  entry: string | undefined;
  node: string | null;
  json: boolean;
  quiet: boolean;
  noColor: boolean;
};

function prepareCommand(argv: string[]): PreparedCommand {
  const token = findCommandToken(argv);
  const command = requireCommand(token.name as string);
  const rest = [...argv.slice(0, token.index), ...argv.slice(token.index + 1)];
  const { globals, rest: commandArgv } = splitGlobalFlags(rest, mergedSpec(command.flags));
  return {
    command,
    commandArgv,
    showHelp: flagBool(globals, 'help'),
    timeout: requireTimeout(flagNumber(globals, 'timeout')),
    ca: flagString(globals, 'ca'),
    insecure: flagBool(globals, 'insecure'),
    entry: flagString(globals, 'entry'),
    node: flagString(globals, 'node') ?? null,
    json: flagBool(globals, 'json'),
    quiet: flagBool(globals, 'quiet'),
    noColor: flagBool(globals, 'no-color'),
  };
}

async function executeCommand(prepared: PreparedCommand, out: Output): Promise<number> {
  captureDiagnostics(prepared.quiet);
  const tls = loadTlsSettings(prepared.ca, prepared.insecure);
  if (tls.insecure) {
    // 关掉证书校验必须显眼：中间人此时完全不可见。
    out.error('WARNING: --insecure disables TLS certificate verification for this command');
  }
  const ctx = buildContext({
    tls,
    entryFlag: prepared.entry,
    node: prepared.node,
    json: prepared.json,
    quiet: prepared.quiet,
    noColor: prepared.noColor,
    ...(prepared.timeout === undefined ? {} : { timeoutMs: prepared.timeout }),
  });
  await prepareProcessTls(ctx.globals.entry, tls);
  const code = await prepared.command.run(ctx, prepared.commandArgv);
  return typeof code === 'number' ? code : EXIT_OK;
}

async function runKnownCommand(argv: string[], out: Output): Promise<number> {
  const prepared = prepareCommand(argv);
  if (prepared.showHelp) {
    out.line(prepared.command.usage);
    return EXIT_OK;
  }
  return executeCommand(prepared, out);
}

type DispatchHandler = {
  match: (argv: string[], globalHelp: string) => string | null;
  run: (argv: string[], out: Output, matched: string) => Promise<number>;
};

const DISPATCH_TABLE: readonly DispatchHandler[] = [
  {
    match: (argv, globalHelp) => helpForArgv(argv, globalHelp),
    async run(_argv, out, matched) {
      out.line(matched);
      return EXIT_OK;
    },
  },
  {
    match: () => '',
    async run(argv, out) {
      return runKnownCommand(argv, out);
    },
  },
];

export async function dispatch(argv: string[], out: Output, globalHelp: string): Promise<number> {
  for (const handler of DISPATCH_TABLE) {
    const matched = handler.match(argv, globalHelp);
    if (matched === null) continue;
    return handler.run(argv, out, matched);
  }
  return EXIT_OK;
}
