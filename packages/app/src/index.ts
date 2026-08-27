import { cliHelpText } from './cli/help';
import { runDoctor } from './commands/doctor';
import { runInit } from './commands/init';
import { runUninstall } from './commands/uninstall';
import { runUpgrade } from './commands/upgrade';
import { type CliLang, normalizeLang, setLang, t } from './i18n';
import { parseArgs, resolveNestedCommand } from './lib/args';
import { loadInstallEnv } from './lib/local-auth';
import type { ParsedArgs } from './types';

function printHelp(lang: CliLang): void {
  console.log(cliHelpText(lang));
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

const AUTH_COMMANDS = new Set([
  'hub.user.add',
  'hub.user.passwd',
  'hub.user.totp',
  'hub.user.reset',
  'hub.join',
  'hub.leave',
  'mesh.reset-root',
  'enroll',
]);

export async function dispatchCli(parsed: ParsedArgs, lang: CliLang): Promise<void> {
  const nested = resolveNestedCommand(parsed);
  if (AUTH_COMMANDS.has(nested.name)) {
    await loadInstallEnv(parsed);
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
      printHelp(lang);
      return;
    case 'hub.user.add': {
      const { runHubUserAdd } = await import('./commands/hub');
      await runHubUserAdd(parsed, nested.rest[0] ?? '');
      return;
    }
    case 'hub.user.passwd': {
      const { runHubUserPasswd } = await import('./commands/hub');
      await runHubUserPasswd(parsed, nested.rest[0] ?? '');
      return;
    }
    case 'hub.user.totp': {
      const { runHubUserTotp } = await import('./commands/hub');
      await runHubUserTotp(parsed, nested.rest[0] ?? '');
      return;
    }
    case 'hub.user.reset': {
      const { runHubUserReset } = await import('./commands/hub');
      await runHubUserReset(parsed);
      return;
    }
    case 'hub.join': {
      const { runHubJoin } = await import('./commands/hub');
      await runHubJoin(parsed, nested.rest[0] ?? '');
      return;
    }
    case 'hub.leave': {
      const { runHubLeave } = await import('./commands/hub');
      await runHubLeave(parsed);
      return;
    }
    case 'mesh.reset-root': {
      const { runMeshResetRoot } = await import('./commands/mesh');
      await runMeshResetRoot(parsed);
      return;
    }
    case 'enroll': {
      const { runEnroll } = await import('./commands/enroll');
      await runEnroll(parsed);
      return;
    }
    case 'direct':
      await dispatchDirect(parsed);
      return;
    default:
      throw new Error(
        t('cli.error.unknownCommand', { command: parsed.command ?? nested.raw ?? '' })
      );
  }
}

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const requestedLang =
    (typeof parsed.flags.lang === 'string' ? parsed.flags.lang : undefined) ||
    process.env.TMEX_CLI_LANG;
  const lang = normalizeLang(requestedLang);
  setLang(lang);
  await dispatchCli(parsed, lang);
}
