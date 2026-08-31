import 'reflect-metadata';
import { type CliLang, normalizeLang, setLang, t } from './i18n';
import { parseArgs, resolveNestedCommand } from './lib/args';
import { loadInstallEnv } from './lib/local-auth';
import type { ParsedArgs } from './types';

export async function dispatchAuthCli(parsed: ParsedArgs, lang: CliLang): Promise<void> {
  setLang(lang);
  const nested = resolveNestedCommand(parsed);
  if (nested.name !== 'help') {
    await loadInstallEnv(parsed);
  }

  switch (nested.name) {
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
    case 'help':
      console.log(t('cli.help'));
      return;
    default:
      throw new Error(
        t('cli.error.unknownCommand', { command: parsed.command ?? nested.raw ?? '' })
      );
  }
}

export async function main(): Promise<void> {
  process.env.TMEX_CLI_AUTH_RUNTIME = '1';
  const parsed = parseArgs(process.argv.slice(2));
  const requestedLang =
    (typeof parsed.flags.lang === 'string' ? parsed.flags.lang : undefined) ||
    process.env.TMEX_CLI_LANG;
  const lang = normalizeLang(requestedLang);
  setLang(lang);
  if (parsed.flags.help === true) {
    console.log(t('cli.help'));
    return;
  }
  const { assertKnownFlags } = await import('./lib/args');
  assertKnownFlags(parsed);
  await dispatchAuthCli(parsed, lang);
}

const isMain = Boolean((import.meta as ImportMeta & { main?: boolean }).main);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
