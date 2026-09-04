import { resolvePassword } from '../lib/password';
import {
  RelayPasswordJoinError,
  type RelayPasswordJoinResult,
  performRelayPasswordJoin,
} from '../lib/relay-password-join';
import { asString } from '../lib/validate';
import { applyRelayPasswordJoinEnv, commitRelayPasswordJoinEnv } from '../runtime/setup-shared';
import type { ParsedArgs } from '../types';
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
  const flagged = asString(parsed.flags.url);
  if (flagged) return flagged;
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
      }
    );
    if (ctx.envPath) {
      await writeRelayNodeEnv(ctx.envPath);
    } else {
      const next = applyRelayPasswordJoinEnv({
        TMEX_ROLES: ctx.env?.TMEX_ROLES ?? process.env.TMEX_ROLES ?? '',
      });
      process.env.TMEX_ROLES = next.TMEX_ROLES;
      process.env.TMEX_HUB_URL = '';
      process.env.TMEX_HUB_PUBLIC_URL = '';
    }
    if (ctx.installDir) {
      await maybeRestart(parsed, io, ctx.installDir);
    }
    (io.log ?? console.log)(`joined relay ${result.relayUrl} (tenant ${result.tenantId})`);
    return result;
  });
}
