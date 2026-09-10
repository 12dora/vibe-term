// 设备创建 / 编辑请求体：旗标镜像 GUI 表单字段。

import type { FlagValues } from './args';
import { flagNumber, flagString } from './args';
import { mergeBody, readSecretField, resolveJsonBody } from './cmd';
import type { CliContext } from './context';
import { UsageError } from './errors';

const DEVICE_TYPES = new Set(['local', 'ssh']);
const AUTH_MODES = new Set(['password', 'key', 'agent', 'configRef', 'auto']);

function setString(
  body: Record<string, unknown>,
  flags: FlagValues,
  flag: string,
  key: string
): void {
  const value = flagString(flags, flag);
  if (value) body[key] = value;
}

function enumFlag(
  flags: FlagValues,
  flag: string,
  allowed: Set<string>,
  message: string
): string | undefined {
  const value = flagString(flags, flag);
  if (!value) return undefined;
  if (!allowed.has(value)) throw new UsageError(message);
  return value;
}

function applyDeviceFlags(flags: FlagValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  setString(body, flags, 'name', 'name');
  const type = enumFlag(flags, 'type', DEVICE_TYPES, '--type must be local|ssh');
  if (type) body.type = type;
  setString(body, flags, 'host', 'host');
  const port = flagNumber(flags, 'port');
  if (port !== undefined) body.port = port;
  setString(body, flags, 'user', 'username');
  const authMode = enumFlag(
    flags,
    'auth-mode',
    AUTH_MODES,
    '--auth-mode must be password|key|agent|configRef|auto'
  );
  if (authMode) body.authMode = authMode;
  setString(body, flags, 'session', 'session');
  setString(body, flags, 'cwd', 'defaultWorkingDir');
  setString(body, flags, 'ssh-config', 'sshConfigRef');
  return body;
}

function requireDeviceFields(
  merged: Record<string, unknown>,
  required: { name?: boolean; type?: boolean }
): void {
  if (required.name && typeof merged.name !== 'string') throw new UsageError('missing --name');
  if (required.type && typeof merged.type !== 'string') {
    throw new UsageError('missing --type local|ssh');
  }
  if (required.type && !merged.authMode) merged.authMode = 'auto';
}

async function applyDeviceSecrets(
  ctx: CliContext,
  flags: FlagValues,
  body: Record<string, unknown>
): Promise<void> {
  const password = await readSecretField(ctx, flags, {
    flag: 'password',
    envName: 'VIBETERM_DEVICE_PASSWORD',
  });
  if (password) body.password = password;
  const privateKey = await readSecretField(ctx, flags, {
    flag: 'private-key',
    envName: 'VIBETERM_DEVICE_PRIVATE_KEY',
  });
  if (privateKey) body.privateKey = privateKey;
  const passphrase = await readSecretField(ctx, flags, {
    flag: 'passphrase',
    envName: 'VIBETERM_DEVICE_PASSPHRASE',
  });
  if (passphrase) body.privateKeyPassphrase = passphrase;
}

export async function deviceMutationBody(
  ctx: CliContext,
  flags: FlagValues,
  required: { name?: boolean; type?: boolean }
): Promise<Record<string, unknown>> {
  const extra = await resolveJsonBody(flagString(flags, 'body'));
  const merged = mergeBody(applyDeviceFlags(flags), extra);
  await applyDeviceSecrets(ctx, flags, merged);
  requireDeviceFields(merged, required);
  return merged;
}

export function parseOrderIds(raw: string | undefined, positionals: string[]): string[] {
  if (raw) {
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (positionals.length > 0) return positionals;
  throw new UsageError('missing device ids', 'pass --ids id1,id2 or list them as arguments');
}
