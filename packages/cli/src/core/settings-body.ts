// settings 各组的请求体拼装。

import type { FlagValues } from './args';
import { flagBool, flagString, flagStrings } from './args';
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

export function splitCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

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

const SEARCH_PROVIDERS = new Set(['none', 'tavily', 'brave']);

export async function llmProviderModelsBody(flags: FlagValues): Promise<Record<string, unknown>> {
  const extra = await optionalObjectBody(flags);
  const manual = flagString(flags, 'manual');
  const disabled = flagString(flags, 'disable');
  const clearManual = flagBool(flags, 'clear-manual');
  const clearDisabled = flagBool(flags, 'clear-disabled');
  if (clearManual && manual) {
    throw new UsageError('pass either --manual or --clear-manual, not both');
  }
  if (clearDisabled && disabled) {
    throw new UsageError('pass either --disable or --clear-disabled, not both');
  }
  const body: Record<string, unknown> = {
    ...(clearManual ? { manualModels: [] } : {}),
    ...(manual ? { manualModels: splitCsv(manual) } : {}),
    ...(clearDisabled ? { disabledModels: [] } : {}),
    ...(disabled ? { disabledModels: splitCsv(disabled) } : {}),
  };
  const merged = mergeBody(body, extra);
  if (!('manualModels' in merged) && !('disabledModels' in merged)) {
    throw new UsageError(
      'llm providers models requires --manual, --disable, --clear-manual, --clear-disabled, or --body'
    );
  }
  return merged;
}

export async function llmDefaultBody(flags: FlagValues): Promise<Record<string, unknown>> {
  const extra = await optionalObjectBody(flags);
  const provider = flagString(flags, 'provider');
  const model = flagString(flags, 'model');
  const merged = mergeBody(
    {
      ...(provider ? { defaultProviderId: provider } : {}),
      ...(model !== undefined ? { defaultModelId: model || null } : {}),
    },
    extra
  );
  if (merged.defaultProviderId === undefined || merged.defaultModelId === undefined) {
    throw new UsageError('llm default requires --provider and --model (or --body)');
  }
  return merged;
}

export async function llmSearchBody(
  ctx: CliContext,
  flags: FlagValues,
  provider: string
): Promise<Record<string, unknown>> {
  if (!SEARCH_PROVIDERS.has(provider)) {
    throw new UsageError(`unknown search provider: ${provider}`, 'use none|tavily|brave');
  }
  const extra = await optionalObjectBody(flags);
  const tavily = await readSecretField(ctx, flags, {
    flag: 'tavily-key',
    envName: 'VIBETERM_TAVILY_API_KEY',
  });
  const brave = await readSecretField(ctx, flags, {
    flag: 'brave-key',
    envName: 'VIBETERM_BRAVE_API_KEY',
  });
  const body: Record<string, unknown> = { searchProvider: provider };
  if (tavily) body.tavilyApiKey = tavily;
  if (brave) body.braveApiKey = brave;
  if (flagBool(flags, 'clear-keys')) {
    body.tavilyApiKey = '';
    body.braveApiKey = '';
  }
  return mergeBody(body, extra);
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

const ACCESS_MODES = new Set(['none', 'login', 'cloudflare']);

function parseAccessRuleFlag(raw: string): { kind: 'email' | 'email_domain'; value: string } {
  const idx = raw.indexOf(':');
  if (idx <= 0) {
    throw new UsageError(`invalid --rule ${raw}`, 'use email:<addr> or domain:<name>');
  }
  const kindRaw = raw.slice(0, idx).trim().toLowerCase();
  const value = raw
    .slice(idx + 1)
    .trim()
    .toLowerCase();
  if (!value) throw new UsageError(`invalid --rule ${raw}`, 'value is empty');
  if (kindRaw === 'email') return { kind: 'email', value };
  if (kindRaw === 'domain' || kindRaw === 'email_domain') return { kind: 'email_domain', value };
  throw new UsageError(`unknown --rule kind: ${kindRaw}`, 'use email: or domain:');
}

async function tunnelAccessFields(
  ctx: CliContext,
  action: string,
  flags: FlagValues
): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  if (action === 'set_access_mode') {
    const accessMode = flagString(flags, 'access-mode');
    if (accessMode) {
      if (!ACCESS_MODES.has(accessMode)) {
        throw new UsageError(`unknown --access-mode: ${accessMode}`, 'use none|login|cloudflare');
      }
      fields.accessMode = accessMode;
    }
  }
  if (action === 'set_access_credentials') {
    const apiToken = await readSecretField(ctx, flags, {
      flag: 'api-token',
      envName: 'VIBETERM_TUNNEL_API_TOKEN',
    });
    const accountId = flagString(flags, 'account-id');
    if (apiToken) fields.apiToken = apiToken;
    if (accountId) fields.accountId = accountId;
  }
  if (action === 'configure_access') {
    const rules = flagStrings(flags, 'rule').map(parseAccessRuleFlag);
    if (rules.length > 0) fields.rules = rules;
  }
  return fields;
}

function requireTunnelAccessFields(action: string, body: Record<string, unknown>): void {
  if (action === 'set_access_mode' && typeof body.accessMode !== 'string') {
    throw new UsageError(
      'set_access_mode requires --access-mode none|login|cloudflare (or --body)'
    );
  }
  if (action === 'set_access_credentials') {
    if (typeof body.apiToken !== 'string' || typeof body.accountId !== 'string') {
      throw new UsageError(
        'set_access_credentials requires --api-token and --account-id (or --api-token-stdin/--api-token-file/VIBETERM_TUNNEL_API_TOKEN/--body)'
      );
    }
  }
  if (action === 'configure_access') {
    if (!Array.isArray(body.rules) || body.rules.length === 0) {
      throw new UsageError(
        'configure_access requires --rule email:<addr> and/or --rule domain:<name> (or --body)'
      );
    }
  }
}

export async function tunnelActionBody(
  action: string,
  flags: FlagValues,
  ctx: CliContext
): Promise<Record<string, unknown>> {
  const extra = await optionalObjectBody(flags);
  const hostname = flagString(flags, 'hostname');
  const ack = flagBool(flags, 'acknowledge');
  const autoStart = flagString(flags, 'auto-start');
  const trustProxy = flagString(flags, 'trust-proxy');
  const base: Record<string, unknown> = {
    action,
    ...(hostname ? { hostname } : {}),
    ...(ack ? { acknowledgeExposure: true } : {}),
    ...(autoStart ? { autoStart: parseOnOff(autoStart) } : {}),
    ...(trustProxy ? { trustProxy: parseOnOff(trustProxy) } : {}),
    ...(await tunnelAccessFields(ctx, action, flags)),
  };
  const body = mergeBody(base, extra);
  requireTunnelAccessFields(action, body);
  return body;
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
