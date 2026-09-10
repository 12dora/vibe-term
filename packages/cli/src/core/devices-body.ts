// 设备创建 / 编辑请求体：旗标镜像 GUI 表单字段。

import type { FlagValues } from './args';
import { flagNumber, flagString } from './args';
import { mergeBody, resolveJsonBody } from './cmd';
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
  setString(body, flags, 'password', 'password');
  setString(body, flags, 'private-key', 'privateKey');
  setString(body, flags, 'passphrase', 'privateKeyPassphrase');
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

export async function deviceMutationBody(
  flags: FlagValues,
  required: { name?: boolean; type?: boolean }
): Promise<Record<string, unknown>> {
  const extra = await resolveJsonBody(flagString(flags, 'body'));
  const merged = mergeBody(applyDeviceFlags(flags), extra);
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
