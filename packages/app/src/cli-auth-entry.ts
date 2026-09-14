import { applyLegacyEnvAliases } from '../../shared/src/env/load-env';
import { errorMessage } from './lib/error-message';
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

const user = async () => await import('./commands/user');
const relay = async () => await import('./commands/relay');
const relayAdmin = async () => await import('./commands/relay-admin');

const HANDLERS: Partial<Record<NestedCommandName, AuthHandler>> = {
  'tls.reset': async (p) => await (await import('./commands/tls')).runTlsReset(p),
  'user.add': async (p, n) => await (await user()).runUserAdd(p, n.rest[0] ?? ''),
  'user.passwd': async (p, n) => await (await user()).runUserPasswd(p, n.rest[0] ?? ''),
  'user.totp': async (p, n) => await (await user()).runUserTotp(p, n.rest[0] ?? ''),
  'mesh.reset-identity': async (p) =>
    await (await import('./commands/mesh')).runMeshResetIdentity(p),
  'mesh.keylog.status': async (p) => await (await import('./commands/mesh')).runMeshKeylogStatus(p),
  'mesh.reset-root': async (p) => await (await import('./commands/mesh')).runMeshResetRoot(p),
  'mesh.passkey.remove-all': async (p, n) =>
    await (await import('./commands/mesh')).runMeshPasskeyRemoveAll(p, n.rest[0] ?? ''),
  'relay.status': async (p) => await (await relayAdmin()).runRelayStatus(p),
  'relay.tenants': async (p) => await (await relayAdmin()).runRelayTenants(p),
  'relay.metrics': async (p) => await (await relayAdmin()).runRelayMetrics(p),
  'relay.passwd': async (p) => await (await relayAdmin()).runRelayPasswd(p),
  'relay.kick': async (p, n) => await (await relayAdmin()).runRelayKick(p, n.rest[0] ?? ''),
  'relay.remove': async (p, n) => await (await relayAdmin()).runRelayRemove(p, n.rest[0] ?? ''),
  'relay.quota': async (p, n) => await (await relayAdmin()).runRelayQuota(p, n.rest[0] ?? ''),
  'relay.limits': async (p) => await (await relayAdmin()).runRelayLimits(p),
  'relay.label': async (p, n) => await (await relayAdmin()).runRelayLabel(p, n.rest),
  'relay.enroll': async (p, n) => await (await relay()).runRelayEnroll(p, n.rest[0] ?? ''),
  'relay.join': async (p) => await (await import('./commands/relay-join')).runRelayJoinCommand(p),
  'relay.reauth': async (p, n) => await (await relay()).runRelayReauth(p, n.rest[0] ?? ''),
  'relay.pack.upload': async (p) => await (await relay()).runRelayPackUpload(p),
  'relay.resend-token': async (p) => await (await relay()).runRelayResendToken(p),
  'relay.leave': async (p) => await (await relay()).runRelayLeave(p),
  'relay.list': async (p) => await (await relay()).runRelayList(p),
  'relay.unpin': async (p) => await (await relay()).runRelayUnpin(p),
  'relay.trust.refresh': async (p, n) =>
    await (await import('./commands/relay-trust')).runRelayTrustRefresh(p, n.rest[0] ?? ''),
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
  // 已有安装的 app.env / 用户脚本里仍是 TMEX_*，读任何配置前先镜像成 VIBETERM_*。
  applyLegacyEnvAliases();
  process.env.VIBETERM_CLI_AUTH_RUNTIME = '1';
  const parsed = parseArgs(process.argv.slice(2));
  const requestedLang =
    (typeof parsed.flags.lang === 'string' ? parsed.flags.lang : undefined) ||
    process.env.VIBETERM_CLI_LANG;
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
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
