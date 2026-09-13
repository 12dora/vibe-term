// settings 各组的请求体拼装。

import type { FlagValues } from './args';
import { flagBool, flagString } from './args';
import {
  coerceScalar,
  mergeBody,
  parseOnOff,
  readSecretField,
  requireObjectBody,
  resolveJsonBody,
} from './cmd';
import type { CliContext } from './context';
import { UsageError } from './errors';

const SITE_KEYS = new Set([
  'siteName',
  'siteUrl',
  'bellThrottleSeconds',
  'notificationThrottleSeconds',
  'enableBrowserNotificationToast',
  'enableNotificationPush',
  'enableBellPush',
  'enableBellSound',
  'sshReconnectMaxRetries',
  'sshReconnectDelaySeconds',
  'language',
  'disabledNotificationChannels',
]);

export function sitePatch(key: string, value: string): Record<string, unknown> {
  if (!SITE_KEYS.has(key)) {
    throw new UsageError(`unknown site setting: ${key}`, `known: ${[...SITE_KEYS].join(', ')}`);
  }
  return { [key]: coerceScalar(value) };
}

export async function optionalObjectBody(
  flags: FlagValues
): Promise<Record<string, unknown> | undefined> {
  const extra = await resolveJsonBody(flagString(flags, 'body'));
  if (extra === undefined) return undefined;
  return requireObjectBody(extra, 'pass --body with a JSON object');
}

export async function requiredObjectBody(
  flags: FlagValues,
  hint: string
): Promise<Record<string, unknown>> {
  return requireObjectBody(await resolveJsonBody(flagString(flags, 'body')), hint);
}

export async function webhookCreateBody(
  ctx: CliContext,
  flags: FlagValues
): Promise<Record<string, unknown>> {
  const extra = await optionalObjectBody(flags);
  const url = flagString(flags, 'url');
  const secret = await readSecretField(ctx, flags, {
    flag: 'secret',
    envName: 'VIBETERM_WEBHOOK_SECRET',
  });
  const events = flagString(flags, 'events');
  const body = mergeBody(
    {
      ...(url ? { url } : {}),
      ...(events
        ? {
            eventMask: events
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
          }
        : {}),
    },
    extra
  );
  if (secret) body.secret = secret;
  if (typeof body.url !== 'string' || typeof body.secret !== 'string') {
    throw new UsageError(
      'webhooks add requires --url and --secret (or --secret-stdin/--secret-file/VIBETERM_WEBHOOK_SECRET/--body)'
    );
  }
  return body;
}

export async function llmProviderBody(
  ctx: CliContext,
  flags: FlagValues,
  required: boolean
): Promise<Record<string, unknown>> {
  const extra = await optionalObjectBody(flags);
  const apiKey = await readSecretField(ctx, flags, {
    flag: 'api-key',
    envName: 'VIBETERM_LLM_API_KEY',
  });
  const body = mergeBody(
    {
      ...(flagString(flags, 'name') ? { name: flagString(flags, 'name') } : {}),
      ...(flagString(flags, 'protocol') ? { protocol: flagString(flags, 'protocol') } : {}),
      ...(flagString(flags, 'base-url') ? { baseUrl: flagString(flags, 'base-url') } : {}),
    },
    extra
  );
  if (apiKey) body.apiKey = apiKey;
  if (required && (!body.name || !body.protocol || !body.baseUrl || !body.apiKey)) {
    throw new UsageError(
      'llm providers add requires --name --protocol --base-url --api-key (or --api-key-stdin/--api-key-file/VIBETERM_LLM_API_KEY/--body)'
    );
  }
  return body;
}

export function enabledFromFlags(flags: FlagValues, positional?: string): boolean {
  if (positional) return parseOnOff(positional);
  const raw = flagString(flags, 'enabled');
  if (raw) return parseOnOff(raw);
  if (flagBool(flags, 'on')) return true;
  if (flagBool(flags, 'off')) return false;
  throw new UsageError('missing on|off', 'pass on/off or --enabled true|false');
}

export const TUNNEL_ACTIONS = [
  'install',
  'login',
  'cancel_login',
  'create',
  'quick_start',
  'start',
  'stop',
  'remove',
  'check',
  'set_auto_start',
  'set_trust_proxy',
  'set_access_credentials',
  'clear_access_credentials',
  'configure_access',
  'remove_access',
  'sync_access',
  'adopt_external',
  'set_access_enforce',
  'set_access_mode',
] as const;

export async function tunnelActionBody(
  action: string,
  flags: FlagValues
): Promise<Record<string, unknown>> {
  const extra = await optionalObjectBody(flags);
  const hostname = flagString(flags, 'hostname');
  const ack = flagBool(flags, 'acknowledge');
  const base: Record<string, unknown> = {
    action,
    ...((extra as Record<string, unknown> | undefined) ?? {}),
  };
  if (hostname) base.hostname = hostname;
  if (ack) base.acknowledgeExposure = true;
  const autoStart = flagString(flags, 'auto-start');
  if (autoStart) base.autoStart = parseOnOff(autoStart);
  const trustProxy = flagString(flags, 'trust-proxy');
  if (trustProxy) base.trustProxy = parseOnOff(trustProxy);
  return base;
}

export const LOCAL_DIRECT_ACTIONS = new Set(['install', 'remove', 'enable', 'disable']);

function optionalOnOff(flags: FlagValues, name: string): boolean | undefined {
  const raw = flagString(flags, name);
  if (!raw) return undefined;
  return parseOnOff(raw);
}

function messagingFlags(flags: FlagValues): Record<string, unknown> {
  const name = flagString(flags, 'name');
  const enabled = flagBool(flags, 'on')
    ? true
    : flagBool(flags, 'off')
      ? false
      : optionalOnOff(flags, 'enabled');
  const allowAuth = optionalOnOff(flags, 'allow-auth');
  const allowCommands = optionalOnOff(flags, 'allow-commands');
  return {
    ...(name ? { name } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(allowAuth !== undefined ? { allowAuthRequests: allowAuth } : {}),
    ...(allowCommands !== undefined ? { allowCommands } : {}),
  };
}

export async function telegramBotBody(
  ctx: CliContext,
  flags: FlagValues,
  required: boolean
): Promise<Record<string, unknown>> {
  const extra = await optionalObjectBody(flags);
  const token = await readSecretField(ctx, flags, {
    flag: 'token',
    envName: 'VIBETERM_TELEGRAM_TOKEN',
  });
  const body = mergeBody(messagingFlags(flags), extra);
  if (token) body.token = token;
  if (required && (typeof body.name !== 'string' || typeof body.token !== 'string')) {
    throw new UsageError(
      'telegram add requires --name and --token (or --token-stdin/--token-file/VIBETERM_TELEGRAM_TOKEN/--body)'
    );
  }
  return body;
}

export async function weixinAccountBody(
  flags: FlagValues,
  required: boolean
): Promise<Record<string, unknown>> {
  const extra = await optionalObjectBody(flags);
  const body = mergeBody(messagingFlags(flags), extra);
  if (required && typeof body.name !== 'string') {
    throw new UsageError('weixin add requires --name (or --body {"name":"…"})');
  }
  return body;
}

/** TLS mode none / trustProxy 会让局域网客户端伪造 X-Forwarded-* 绕过地址判断。 */
export const LAN_SPOOF_CONFIRM =
  'this setting disables TLS or trusts X-Forwarded-* headers; a LAN client can spoof those headers and bypass address checks';

export function tlsSetNeedsConfirm(body: Record<string, unknown>): boolean {
  return body.mode === 'none' || body.trustProxy === true;
}
