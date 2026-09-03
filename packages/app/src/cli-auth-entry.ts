import 'reflect-metadata';
import { type CliLang, normalizeLang, setLang, t } from './i18n';
import {
  type NestedCommand,
  type NestedCommandName,
  parseArgs,
  resolveNestedCommand,
} from './lib/args';
import { loadInstallEnv } from './lib/local-auth';
import type { ParsedArgs } from './types';

type AuthHandler = (parsed: ParsedArgs, nested: NestedCommand) => Promise<unknown>;

const hub = async () => await import('./commands/hub');
const relay = async () => await import('./commands/relay');
const relayAdmin = async () => await import('./commands/relay-admin');

const HANDLERS: Partial<Record<NestedCommandName, AuthHandler>> = {
  'hub.user.add': async (p, n) => await (await hub()).runHubUserAdd(p, n.rest[0] ?? ''),
  'hub.user.passwd': async (p, n) => await (await hub()).runHubUserPasswd(p, n.rest[0] ?? ''),
  'hub.user.totp': async (p, n) => await (await hub()).runHubUserTotp(p, n.rest[0] ?? ''),
  'hub.user.reset': async (p) => await (await hub()).runHubUserReset(p),
  'hub.join': async (p, n) => await (await hub()).runHubJoin(p, n.rest[0] ?? ''),
  'hub.leave': async (p) => await (await hub()).runHubLeave(p),
  'hub.standby': async (p) => await (await hub()).runHubStandby(p),
  'hub.promote': async (p) => await (await hub()).runHubPromote(p),
  'hub.demote': async (p) => await (await hub()).runHubDemote(p),
  'hub.list': async (p) => await (await hub()).runHubList(p),
  'hub.allow': async (p, n) => await (await hub()).runHubAllow(p, n.rest),
  'hub.disallow': async (p, n) => await (await hub()).runHubDisallow(p, n.rest[0] ?? ''),
  'mesh.reset-root': async (p) => await (await import('./commands/mesh')).runMeshResetRoot(p),
  enroll: async (p) => await (await import('./commands/enroll')).runEnroll(p),
  'relay.status': async (p) => await (await relayAdmin()).runRelayStatus(p),
  'relay.tenants': async (p) => await (await relayAdmin()).runRelayTenants(p),
  'relay.passwd': async (p) => await (await relayAdmin()).runRelayPasswd(p),
  'relay.kick': async (p, n) => await (await relayAdmin()).runRelayKick(p, n.rest[0] ?? ''),
  'relay.remove': async (p, n) => await (await relayAdmin()).runRelayRemove(p, n.rest[0] ?? ''),
  'relay.quota': async (p, n) => await (await relayAdmin()).runRelayQuota(p, n.rest[0] ?? ''),
  'relay.label': async (p, n) => await (await relayAdmin()).runRelayLabel(p, n.rest),
  'relay.enroll': async (p, n) => await (await relay()).runRelayEnroll(p, n.rest[0] ?? ''),
  'relay.reauth': async (p, n) => await (await relay()).runRelayReauth(p, n.rest[0] ?? ''),
  'relay.leave': async (p) => await (await relay()).runRelayLeave(p),
  'relay.list': async (p) => await (await relay()).runRelayList(p),
};

export async function dispatchAuthCli(parsed: ParsedArgs, lang: CliLang): Promise<void> {
  setLang(lang);
  const nested = resolveNestedCommand(parsed);
  if (nested.name !== 'help') {
    await loadInstallEnv(parsed);
  }
  if (nested.name === 'help') {
    console.log(t('cli.help'));
    return;
  }
  const handler = HANDLERS[nested.name];
  if (!handler) {
    throw new Error(t('cli.error.unknownCommand', { command: parsed.command ?? nested.raw ?? '' }));
  }
  await handler(parsed, nested);
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
