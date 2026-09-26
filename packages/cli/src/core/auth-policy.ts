// 登录限制：把旗标收成 LoginPolicy，再用根钥签 `login-policy`（与 settings totp 同一条 keylog）。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  LOGIN_POLICY_PRESETS,
  type LoginPolicy,
  type LoginPolicyStatus,
  MIN_LOGIN_POLICY_RECORD_VERSION,
  loginPolicyFromPreset,
  signLoginPolicyRecordWithRoot,
  validateLoginPolicy,
} from '@vibeterm/shared/auth';
import type { FlagValues } from './args';
import { flagBool, flagNumber, flagString } from './args';
import type { AuthMode } from './auth';
import { fetchAuthMode } from './auth';
import { formatDurationMs, parsePolicyDuration } from './auth-format';
import type { CliContext } from './context';
import { CliError, UsageError } from './errors';
import { appendKeyLog, assertKeyLogAppended, deriveRootFromMode, keyLogHead } from './nodes-keylog';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function customProblem(policy: LoginPolicy): string | null {
  if (!inRange(policy.ipFailThreshold, 3, 100)) {
    return '--ip-threshold must be an integer from 3 to 100';
  }
  if (!inRange(policy.ipLockBaseMs, MINUTE, DAY)) return '--ip-lock must be from 1m to 24h';
  if (policy.ipLockMaxMs < policy.ipLockBaseMs || policy.ipLockMaxMs > 7 * DAY) {
    return '--ip-lock-max must be from --ip-lock up to 7d';
  }
  if (!inRange(policy.accountFailPerHour, 10, 1000)) {
    return '--account-per-hour must be an integer from 10 to 1000';
  }
  if (!inRange(policy.accountLockMs, MINUTE, DAY)) return '--account-lock must be from 1m to 24h';
  return null;
}

export function assertPolicyDraft(policy: LoginPolicy): void {
  if (policy.preset === 'custom') {
    const problem = customProblem(policy);
    if (problem) throw new UsageError(problem);
  } else {
    const preset = LOGIN_POLICY_PRESETS[policy.preset];
    const same =
      policy.ipFailThreshold === preset.ipFailThreshold &&
      policy.ipLockBaseMs === preset.ipLockBaseMs &&
      policy.ipLockMaxMs === preset.ipLockMaxMs &&
      policy.accountFailPerHour === preset.accountFailPerHour &&
      policy.accountLockMs === preset.accountLockMs;
    if (!same) throw new UsageError(`preset ${policy.preset} does not match its fixed limits`);
  }
  if (!validateLoginPolicy(policy).ok) throw new UsageError('login policy is invalid');
}

function requireInt(flags: FlagValues, name: string): number {
  const value = flagNumber(flags, name);
  if (value === undefined) throw new UsageError(`--custom requires --${name}`);
  if (!Number.isInteger(value)) throw new UsageError(`--${name} must be an integer`);
  return value;
}

function requireDuration(flags: FlagValues, name: string): number {
  const raw = flagString(flags, name);
  if (!raw) throw new UsageError(`--custom requires --${name}`);
  return parsePolicyDuration(raw);
}

function presetPolicy(name: string, exemptLocal: boolean): LoginPolicy {
  if (name !== 'relaxed' && name !== 'standard' && name !== 'strict') {
    throw new UsageError(`unknown preset: ${name}`, 'use relaxed, standard, or strict');
  }
  return loginPolicyFromPreset(name, exemptLocal);
}

function customPolicy(flags: FlagValues, exemptLocal: boolean): LoginPolicy {
  return {
    preset: 'custom',
    exemptLocal,
    ipFailThreshold: requireInt(flags, 'ip-threshold'),
    ipLockBaseMs: requireDuration(flags, 'ip-lock'),
    ipLockMaxMs: requireDuration(flags, 'ip-lock-max'),
    accountFailPerHour: requireInt(flags, 'account-per-hour'),
    accountLockMs: requireDuration(flags, 'account-lock'),
  };
}

export function buildPolicyFromFlags(flags: FlagValues): LoginPolicy {
  const preset = flagString(flags, 'preset');
  const custom = flagBool(flags, 'custom');
  if (preset && custom) throw new UsageError('--preset and --custom are mutually exclusive');
  if (!preset && !custom) {
    throw new UsageError(
      'pass --preset relaxed|standard|strict or --custom',
      'run: vibeterm auth policy --help'
    );
  }
  const exemptLocal = !flagBool(flags, 'no-exempt-local');
  const policy = custom
    ? customPolicy(flags, exemptLocal)
    : presetPolicy(preset as string, exemptLocal);
  assertPolicyDraft(policy);
  return policy;
}

function parseBlockers(raw: unknown): LoginPolicyStatus['blockers'] {
  if (!Array.isArray(raw)) return [];
  const blockers: LoginPolicyStatus['blockers'] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.nodeId !== 'string') continue;
    blockers.push({
      nodeId: row.nodeId,
      name: typeof row.name === 'string' ? row.name : row.nodeId,
      version: typeof row.version === 'string' ? row.version : null,
    });
  }
  return blockers;
}

export function parsePolicySnapshot(raw: unknown): LoginPolicyStatus {
  if (!raw || typeof raw !== 'object') throw new CliError('login policy response is malformed');
  const body = raw as Record<string, unknown>;
  const validated = validateLoginPolicy(body.policy);
  if (!validated.ok) throw new CliError('login policy response is malformed');
  if (body.source !== 'default' && body.source !== 'keylog') {
    throw new CliError('login policy response is malformed');
  }
  return {
    policy: validated.policy,
    source: body.source,
    writable: body.writable === true,
    blockers: parseBlockers(body.blockers),
  };
}

export function formatPolicyLines(snapshot: LoginPolicyStatus): string[] {
  const policy = snapshot.policy;
  const lines = [
    `preset: ${policy.preset}`,
    `source: ${snapshot.source}`,
    `writable: ${snapshot.writable ? 'yes' : 'no'}`,
    `ip threshold: ${policy.ipFailThreshold}`,
    `ip lock: ${formatDurationMs(policy.ipLockBaseMs)} (max ${formatDurationMs(policy.ipLockMaxMs)})`,
    `account: ${policy.accountFailPerHour}/hour, lock ${formatDurationMs(policy.accountLockMs)}`,
    `exempt local: ${policy.exemptLocal ? 'yes' : 'no'}`,
  ];
  if (snapshot.source === 'keylog') {
    lines.push(
      `warning: nodes below ${MIN_LOGIN_POLICY_RECORD_VERSION} cannot replay a login-policy record; upgrade them before admit or readmit`
    );
  }
  if (snapshot.blockers.length === 0) return lines;
  lines.push('blockers:');
  for (const blocker of snapshot.blockers) {
    lines.push(`  ${blocker.name} (${blocker.nodeId}) ${blocker.version ?? 'unknown'}`);
  }
  return lines;
}

export function policyBlockedMessage(snapshot: LoginPolicyStatus): string {
  const who = snapshot.blockers.map((row) => `${row.name} ${row.version ?? 'unknown'}`).join(', ');
  const need = `login policy cannot be changed until every node is on ${MIN_LOGIN_POLICY_RECORD_VERSION}`;
  return who ? `${need}: ${who}` : need;
}

async function meshMode(ctx: CliContext): Promise<AuthMode> {
  const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
  if (!mode || mode.mode !== 'mesh' || !mode.uid || mode.rootEpoch == null) {
    throw new CliError('this entry is not a mesh instance');
  }
  return mode;
}

export async function signLoginPolicy(
  ctx: CliContext,
  policy: LoginPolicy,
  password: string
): Promise<unknown> {
  const validated = validateLoginPolicy(policy);
  if (!validated.ok) throw new UsageError('login policy is invalid');
  const mode = await meshMode(ctx);
  const root = await deriveRootFromMode(mode, password);
  try {
    const head = await keyLogHead(ctx);
    const signed = signLoginPolicyRecordWithRoot({
      head,
      rootEpoch: mode.rootEpoch as number,
      uid: mode.uid as string,
      policy: validated.policy,
      rootKey: root,
    });
    const result = await appendKeyLog(ctx, signed.bytes, signed.sig);
    assertKeyLogAppended(result, 'login-policy');
    return result;
  } finally {
    root.seed.fill(0);
  }
}
