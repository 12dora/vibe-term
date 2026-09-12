import { t } from '../i18n';
import { resolvePassword } from '../lib/password';
import {
  RelayPasswordJoinError,
  type RelayPasswordJoinResult,
  performRelayPasswordJoin,
} from '../lib/relay-password-join';
import { asString } from '../lib/validate';
import { formatPortPlanForEnv } from '../runtime/local-port-plan';
import { applyRelayPasswordJoinEnv, commitRelayPasswordJoinEnv } from '../runtime/setup-shared';
import type { ParsedArgs } from '../types';
import { enableDirectForOnboarding } from './direct';
import { type HubIo, maybeRestart } from './hub';
import { withAuth } from './with-auth';

export {
  RelayPasswordJoinError,
  performRelayPasswordJoin,
} from '../lib/relay-password-join';
export type {
  RelayPasswordJoinDeps,
  RelayPasswordJoinInput,
  RelayPasswordJoinResult,
} from '../lib/relay-password-join';

async function writeRelayNodeEnv(envPath: string): Promise<void> {
  await commitRelayPasswordJoinEnv({ envPath });
}

function joinUrlFromParsed(parsed: ParsedArgs): string {
  const rest = parsed.positionals.filter((item) => item !== 'relay' && item !== 'join');
  return rest[0] ?? '';
}

export async function runRelayPasswordJoin(
  parsed: ParsedArgs,
  io: HubIo = {}
): Promise<RelayPasswordJoinResult> {
  const tenantId = asString(parsed.flags.tenant);
  if (!tenantId) {
    throw new RelayPasswordJoinError('invalid_url', 'relay join requires --tenant <id>');
  }
  const password = await resolvePassword({
    password:
      typeof io.password === 'string' ? io.password : asString(parsed.flags.password) || undefined,
    confirm: false,
    prompt: 'Mesh password',
  });
  const name = asString(parsed.flags.name) || 'node';
  const caFingerprint = asString(parsed.flags['ca-fingerprint']) || undefined;
  return await withAuth(parsed, io, async (ctx) => {
    const result = await performRelayPasswordJoin(
      {
        relayUrl: joinUrlFromParsed(parsed),
        tenantId,
        password,
        name,
        caFingerprint,
      },
      {
        auth: ctx,
        now: io.now,
        fetcher: io.fetcher,
        timeoutMs: io.relayTimeoutMs,
        log: (message) => (io.log ?? console.log)(message),
      }
    );
    // 同一账户的令牌换发：本机角色与上级早就是中继了，不改 env、也不重启
    if (result.rekeyed) {
      (io.log ?? console.log)(
        `refreshed the relay token for ${result.relayUrl} (tenant ${result.tenantId})`
      );
      return result;
    }
    if (ctx.envPath) {
      await writeRelayNodeEnv(ctx.envPath);
    } else {
      const next = applyRelayPasswordJoinEnv({
        VIBETERM_ROLES: ctx.env?.VIBETERM_ROLES ?? process.env.VIBETERM_ROLES ?? '',
      });
      process.env.VIBETERM_ROLES = next.VIBETERM_ROLES;
      process.env.VIBETERM_HUB_URL = '';
      process.env.VIBETERM_HUB_PUBLIC_URL = '';
    }
    if (ctx.installDir) {
      await enableDirectForOnboarding(ctx.installDir, io, ctx.envPath || undefined);
      await maybeRestart(parsed, io, ctx.installDir);
    }
    (io.log ?? console.log)(`joined relay ${result.relayUrl} (tenant ${result.tenantId})`);
    const next = applyRelayPasswordJoinEnv({
      VIBETERM_ROLES: ctx.env?.VIBETERM_ROLES ?? process.env.VIBETERM_ROLES ?? '',
    });
    const list = formatPortPlanForEnv({ ...ctx.env, VIBETERM_ROLES: next.VIBETERM_ROLES });
    if (list) (io.log ?? console.log)(t('relay.join.portsHint', { list }));
    return result;
  });
}
