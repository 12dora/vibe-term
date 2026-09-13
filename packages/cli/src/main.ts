// `vibeterm` 客户端命令的入口。由 packages/app 的 `vibeterm` 分发到这里（bundle 内 import），
// 也可以直接 `node dist/cli.js <cmd>` 运行。

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setDefaultClientVersion } from '@vibeterm/ws-client';
import { errorText, exitCodeOf, hintOf } from './core/errors';
import { Output, shouldUseColor } from './core/output';
import { dispatch, findCommandToken } from './dispatch';
import { IMPLEMENTED_COMMANDS, RESERVED_COMMANDS } from './registry';
import { cliVersion } from './version';

export { findCommandToken };

const RESERVED_HELP =
  RESERVED_COMMANDS.length === 0
    ? []
    : [
        '',
        'Reserved (not implemented yet):',
        `  ${RESERVED_COMMANDS.map((c) => c.name).join(', ')}`,
      ];

const GLOBAL_HELP = [
  'Usage: vibeterm <command> [options]',
  '',
  'Commands:',
  ...IMPLEMENTED_COMMANDS.map((command) => `  ${command.name.padEnd(10)}${command.summary}`),
  ...RESERVED_HELP,
  '',
  'Global options:',
  '  --entry <url>     gateway entry (default: $VIBETERM_ENTRY, last used, local install, 127.0.0.1:9883)',
  '  --node <id|name>  target node behind the entry (default: the entry itself)',
  '  --json            machine-readable output on stdout',
  '  --quiet           suppress human-facing chatter on stderr',
  '  --no-color        disable ANSI colors',
  '  --timeout <ms>    per-request timeout (default 30000)',
  '  --ca <pem-file>   trust this extra CA for https and wss',
  '  --insecure        do not verify the server certificate (prints a warning; never the default)',
  '  --help, -h        show help for a command',
  '',
  'Exit codes: 0 ok, 1 error, 2 usage, 3 auth required, 4 not found, 5 network.',
  '',
  'Run "vibeterm <command> --help" for the options of one command.',
].join('\n');

function bareOutput(argv: readonly string[]): Output {
  const noColor = argv.includes('--no-color');
  return new Output({ json: false, quiet: false, color: shouldUseColor(noColor) });
}

export async function runCli(argv: string[]): Promise<number> {
  // 网关按 clientVersion 做 canonical v1.1 版本门，建任何 WS 之前必须先注入真实版本。
  setDefaultClientVersion(cliVersion());
  const out = bareOutput(argv);
  try {
    return await dispatch(argv, out, GLOBAL_HELP);
  } catch (error) {
    out.error(`vibeterm: ${errorText(error)}`);
    const hint = hintOf(error);
    if (hint) out.error(`  ${hint}`);
    return exitCodeOf(error);
  }
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
