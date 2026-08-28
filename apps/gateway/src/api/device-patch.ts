import type { AuthMode, Device } from '@tmex/shared';
import { t } from '../i18n';
import {
  type ConfigFieldSpec,
  type FieldParseResult,
  applyConfigFields,
  parseEnumField,
  parseIntegerField,
} from './config-field';

const AUTH_MODES: readonly AuthMode[] = ['password', 'key', 'agent', 'configRef', 'auto'];

const RECONNECT_IF_CHANGED: readonly (keyof Device)[] = [
  'type',
  'host',
  'port',
  'username',
  'sshConfigRef',
  'session',
  'authMode',
];

const RECONNECT_IF_PRESENT: readonly (keyof Device)[] = [
  'passwordEnc',
  'privateKeyEnc',
  'privateKeyPassphraseEnc',
];

export type DeviceUpdateDraft = {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  sshConfigRef?: string;
  session?: string;
  defaultWorkingDir?: string;
  authMode?: AuthMode;
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
};

export type DevicePushAction =
  | { type: 'reconnect' }
  | { type: 'workingDir'; dir: string | undefined }
  | { type: 'none' };

function invalidRequest(): string {
  return t('apiError.invalidRequest');
}

function parsePlainString(raw: unknown): FieldParseResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: invalidRequest() };
  return { ok: true, value: raw };
}

function parseWorkingDir(raw: unknown): FieldParseResult<string | undefined> {
  if (typeof raw !== 'string') return { ok: false, error: invalidRequest() };
  return { ok: true, value: raw.trim() || undefined };
}

const DEVICE_UPDATE_FIELDS: ConfigFieldSpec<unknown>[] = [
  { name: 'name', parse: parsePlainString },
  { name: 'host', parse: parsePlainString },
  { name: 'port', parse: (raw) => parseIntegerField(raw, invalidRequest()) },
  { name: 'username', parse: parsePlainString },
  { name: 'sshConfigRef', parse: parsePlainString },
  { name: 'session', parse: parsePlainString },
  { name: 'defaultWorkingDir', parse: parseWorkingDir },
  { name: 'authMode', parse: (raw) => parseEnumField(raw, AUTH_MODES, invalidRequest()) },
  { name: 'password', parse: parsePlainString },
  { name: 'privateKey', parse: parsePlainString },
  { name: 'privateKeyPassphrase', parse: parsePlainString },
];

export function parseDeviceUpdateFields(
  body: Record<string, unknown>
): { ok: true; fields: DeviceUpdateDraft } | { ok: false; error: string } {
  return applyConfigFields<DeviceUpdateDraft>(body, DEVICE_UPDATE_FIELDS, undefined);
}

export function shouldReconnectPushSupervisor(existing: Device, updates: Partial<Device>): boolean {
  for (const key of RECONNECT_IF_CHANGED) {
    if (updates[key] !== undefined && updates[key] !== existing[key]) return true;
  }
  return RECONNECT_IF_PRESENT.some((key) => updates[key] !== undefined);
}

export function nextDevicePushAction(existing: Device, updates: Partial<Device>): DevicePushAction {
  if (shouldReconnectPushSupervisor(existing, updates)) return { type: 'reconnect' };
  if (
    updates.defaultWorkingDir !== undefined &&
    updates.defaultWorkingDir !== existing.defaultWorkingDir
  ) {
    return { type: 'workingDir', dir: updates.defaultWorkingDir };
  }
  return { type: 'none' };
}
