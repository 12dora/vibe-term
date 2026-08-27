import { runDoctor } from './commands/doctor';
import { runInit } from './commands/init';
import { runUninstall } from './commands/uninstall';
import { runUpgrade } from './commands/upgrade';
import { type CliLang, normalizeLang, setLang, t } from './i18n';
import { parseArgs, resolveNestedCommand } from './lib/args';
import { AUTH_COMMANDS, resolveAuthSpawnPlan, spawnAuthCli } from './lib/auth-spawn';
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
    const message = error instanceof Error ? error.message : String(error);
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
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const requestedLang =
    (typeof parsed.flags.lang === 'string' ? parsed.flags.lang : undefined) ||
    process.env.TMEX_CLI_LANG;
  const lang = normalizeLang(requestedLang);
  setLang(lang);
  await dispatchCli(parsed, lang, { argv });
}
