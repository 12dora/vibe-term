import { applyLegacyEnvAliases } from '../../shared/src/env/load-env';
import { runDoctor } from './commands/doctor';
import { runInit } from './commands/init';
import { runUninstall } from './commands/uninstall';
import { runUpgrade } from './commands/upgrade';
import { type CliLang, normalizeLang, setLang, t } from './i18n';
import { assertKnownFlags, parseArgs, resolveNestedCommand } from './lib/args';
import { AUTH_COMMANDS, resolveAuthSpawnPlan, spawnAuthCli } from './lib/auth-spawn';
import { isClientCliCommand, runClientCli } from './lib/client-cli';
import { errorMessage } from './lib/error-message';
import type { ParsedArgs } from './types';

function printHelp(): void {
  console.log(t('cli.help'));
}

async function dispatchDirect(parsed: ParsedArgs): Promise<void> {
  try {
    const mod = (await import('./commands/direct')) as {
      runDirect?: (args: ParsedArgs) => Promise<void>;
    };
    if (typeof mod.runDirect !== 'function') {
      throw new Error('direct enable|disable is not available in this build (owned by C5-2)');
    }
    await mod.runDirect(parsed);
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes('Cannot find module') || message.includes('not available')) {
      throw new Error('direct enable|disable is not available in this build (owned by C5-2)');
    }
    throw error;
  }
}

export async function dispatchCli(
  parsed: ParsedArgs,
  lang: CliLang,
  options?: { argv?: string[] }
): Promise<void> {
  setLang(lang);
  // 客户端命令（login / api / term / …）整组交给 @vibeterm/cli 的 bundle，
  // 它自己解析旗标与 --help，本包的旗标白名单不适用。
  if (isClientCliCommand(parsed.command)) {
    const code = await runClientCli(options?.argv ?? reconstructArgv(parsed));
    if (code !== 0) process.exitCode = code;
    return;
  }
  const nested = resolveNestedCommand(parsed);
  if (AUTH_COMMANDS.has(nested.name)) {
    const argv = options?.argv ?? reconstructArgv(parsed);
    const plan = await resolveAuthSpawnPlan(parsed, argv);
    const result = await spawnAuthCli(plan);
    if (result.code !== 0) {
      process.exitCode = result.code;
    }
    return;
  }

  switch (nested.name) {
    case 'init':
      await runInit(parsed);
      return;
    case 'doctor':
      await runDoctor(parsed);
      return;
    case 'upgrade':
      await runUpgrade(parsed);
      return;
    case 'uninstall':
      await runUninstall(parsed);
      return;
    case 'help':
      printHelp();
      return;
    case 'direct':
      await dispatchDirect(parsed);
      return;
    default:
      throw new Error(
        t('cli.error.unknownCommand', { command: parsed.command ?? nested.raw ?? '' })
      );
  }
}

function reconstructArgv(parsed: ParsedArgs): string[] {
  const argv: string[] = [];
  if (parsed.command) argv.push(parsed.command);
  argv.push(...parsed.positionals);
  for (const [key, value] of Object.entries(parsed.flags)) {
    if (value === true) {
      argv.push(`--${key}`);
    } else if (typeof value === 'string') {
      argv.push(`--${key}`, value);
    }
  }
  return argv;
}

export async function main(): Promise<void> {
  // 已有安装的 app.env / 用户脚本里仍是 TMEX_*，读任何配置前先镜像成 VIBETERM_*。
  applyLegacyEnvAliases();
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const requestedLang =
    (typeof parsed.flags.lang === 'string' ? parsed.flags.lang : undefined) ||
    process.env.VIBETERM_CLI_LANG;
  const lang = normalizeLang(requestedLang);
  setLang(lang);
  // 客户端命令的 `--help` 由它自己打印（每组有各自的用法），旗标校验同理。
  if (!isClientCliCommand(parsed.command)) {
    if (parsed.flags.help === true) {
      printHelp();
      return;
    }
    assertKnownFlags(parsed);
  }
  await dispatchCli(parsed, lang, { argv });
}
