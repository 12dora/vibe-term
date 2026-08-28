import os from 'node:os';
import type { Device } from '@tmex/shared';
import type { AgentEnvironmentInfo } from './environment';

export interface EnvCollectContext {
  device: Device | null;
  isLocal: boolean;
}

type EnvResolver<K extends keyof AgentEnvironmentInfo> = (
  ctx: EnvCollectContext
) => AgentEnvironmentInfo[K];

export function resolveTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

export function resolveGatewayOs(isLocal: boolean): string | null {
  if (!isLocal) return null;
  return `${os.platform()} ${os.release()} (${os.arch()})`;
}

export function resolveEncoding(isLocal: boolean): string | null {
  return isLocal ? 'utf-8' : null;
}

export function resolveLocale(isLocal: boolean): string | null {
  if (!isLocal) return null;
  return process.env.LANG ?? process.env.LC_ALL ?? null;
}

function deviceValue<K extends 'name' | 'type' | 'host' | 'username' | 'port' | 'session'>(
  device: Device | null,
  key: K
): NonNullable<Device[K]> | null {
  return device?.[key] ?? null;
}

function localEnv(isLocal: boolean, name: string): string | null {
  if (!isLocal) return null;
  return process.env[name] ?? null;
}

export const AGENT_ENV_RESOLVERS: { [K in keyof AgentEnvironmentInfo]: EnvResolver<K> } = {
  deviceName: (ctx) => deviceValue(ctx.device, 'name'),
  deviceType: (ctx) => deviceValue(ctx.device, 'type'),
  host: (ctx) => deviceValue(ctx.device, 'host'),
  username: (ctx) => deviceValue(ctx.device, 'username'),
  port: (ctx) => deviceValue(ctx.device, 'port'),
  tmuxSession: (ctx) => deviceValue(ctx.device, 'session'),
  timezone: () => resolveTimezone(),
  nowIso: () => new Date().toISOString(),
  gatewayOs: (ctx) => resolveGatewayOs(ctx.isLocal),
  gatewayShell: (ctx) => localEnv(ctx.isLocal, 'SHELL'),
  term: (ctx) => localEnv(ctx.isLocal, 'TERM'),
  termProgram: (ctx) => localEnv(ctx.isLocal, 'TERM_PROGRAM'),
  locale: (ctx) => resolveLocale(ctx.isLocal),
  encoding: (ctx) => resolveEncoding(ctx.isLocal),
};

export const AGENT_ENV_FIELD_KEYS = [
  'deviceName',
  'deviceType',
  'host',
  'username',
  'port',
  'tmuxSession',
  'timezone',
  'nowIso',
  'gatewayOs',
  'gatewayShell',
  'term',
  'termProgram',
  'locale',
  'encoding',
] as const satisfies readonly (keyof AgentEnvironmentInfo)[];
