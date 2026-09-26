// 「登录限制」表单：预设三档直接取共享表里的数值；自定义五项逐项给出范围提示，
// 提交前再过一遍共享的 `validateLoginPolicy`（网关与 CLI 用的同一个）。

import {
  type LoginPolicy,
  type LoginPolicyNumbers,
  type LoginPolicyPreset,
  loginPolicyFromPreset,
  validateLoginPolicy,
} from '@vibeterm/shared/auth';
import {
  type DurationDraft,
  durationDraft,
  durationLabel,
  durationMs,
  parsePositiveInt,
} from './duration-field';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const NS = 'auth.security.loginLimit';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** 与共享校验器一致的自定义范围，只用来就地给出逐项提示。 */
export const LOGIN_LIMIT_RANGES = {
  ipFailThreshold: { min: 3, max: 100 },
  ipLockBaseMs: { min: MINUTE_MS, max: DAY_MS },
  ipLockMaxMs: { min: MINUTE_MS, max: 7 * DAY_MS },
  accountFailPerHour: { min: 10, max: 1000 },
  accountLockMs: { min: MINUTE_MS, max: DAY_MS },
} as const;

export interface LoginLimitDraft {
  preset: LoginPolicyPreset;
  ipFailThreshold: string;
  ipLockBase: DurationDraft;
  ipLockMax: DurationDraft;
  accountFailPerHour: string;
  accountLock: DurationDraft;
  exemptLocal: boolean;
}

export type LoginLimitField =
  | 'ipFailThreshold'
  | 'ipLockBase'
  | 'ipLockMax'
  | 'accountFailPerHour'
  | 'accountLock';

export type LoginLimitErrors = Partial<Record<LoginLimitField | 'form', string>>;

export function loginLimitDraft(policy: LoginPolicy): LoginLimitDraft {
  return {
    preset: policy.preset,
    ipFailThreshold: String(policy.ipFailThreshold),
    ipLockBase: durationDraft(policy.ipLockBaseMs),
    ipLockMax: durationDraft(policy.ipLockMaxMs),
    accountFailPerHour: String(policy.accountFailPerHour),
    accountLock: durationDraft(policy.accountLockMs),
    exemptLocal: policy.exemptLocal,
  };
}

/** 切到某个预设：数值换成预设值；切到自定义则保留当前数值作为起点。 */
export function withPreset(draft: LoginLimitDraft, preset: LoginPolicyPreset): LoginLimitDraft {
  if (preset === 'custom') return { ...draft, preset };
  return loginLimitDraft(loginPolicyFromPreset(preset, draft.exemptLocal));
}

function rangeError(
  t: Translate,
  value: number | null,
  range: { min: number; max: number },
  format: (n: number) => string
): string | undefined {
  if (value === null) return t(`${NS}.errors.integer`);
  if (value < range.min || value > range.max) {
    return t(`${NS}.errors.range`, { min: format(range.min), max: format(range.max) });
  }
  return undefined;
}

export type LoginLimitParse =
  | { ok: true; policy: LoginPolicy }
  | { ok: false; errors: LoginLimitErrors };

export function parseLoginLimitDraft(t: Translate, draft: LoginLimitDraft): LoginLimitParse {
  if (draft.preset !== 'custom') {
    return { ok: true, policy: loginPolicyFromPreset(draft.preset, draft.exemptLocal) };
  }
  const numbers = {
    ipFailThreshold: parsePositiveInt(draft.ipFailThreshold),
    ipLockBaseMs: durationMs(draft.ipLockBase),
    ipLockMaxMs: durationMs(draft.ipLockMax),
    accountFailPerHour: parsePositiveInt(draft.accountFailPerHour),
    accountLockMs: durationMs(draft.accountLock),
  };
  const count = (n: number) => String(n);
  const duration = (ms: number) => durationLabel(t, ms);
  const errors: LoginLimitErrors = {
    ipFailThreshold: rangeError(
      t,
      numbers.ipFailThreshold,
      LOGIN_LIMIT_RANGES.ipFailThreshold,
      count
    ),
    ipLockBase: rangeError(t, numbers.ipLockBaseMs, LOGIN_LIMIT_RANGES.ipLockBaseMs, duration),
    ipLockMax: rangeError(t, numbers.ipLockMaxMs, LOGIN_LIMIT_RANGES.ipLockMaxMs, duration),
    accountFailPerHour: rangeError(
      t,
      numbers.accountFailPerHour,
      LOGIN_LIMIT_RANGES.accountFailPerHour,
      count
    ),
    accountLock: rangeError(t, numbers.accountLockMs, LOGIN_LIMIT_RANGES.accountLockMs, duration),
  };
  if (
    !errors.ipLockMax &&
    numbers.ipLockMaxMs !== null &&
    numbers.ipLockBaseMs !== null &&
    numbers.ipLockMaxMs < numbers.ipLockBaseMs
  ) {
    errors.ipLockMax = t(`${NS}.errors.maxBelowBase`);
  }
  const present = Object.fromEntries(
    Object.entries(errors).filter(([, message]) => message !== undefined)
  ) as LoginLimitErrors;
  if (Object.keys(present).length > 0) return { ok: false, errors: present };

  const validated = validateLoginPolicy({
    preset: 'custom',
    exemptLocal: draft.exemptLocal,
    ...numbers,
  });
  if (!validated.ok) return { ok: false, errors: { form: t(`${NS}.errors.invalid`) } };
  return { ok: true, policy: validated.policy };
}

/** 预设卡片上的两行说明。 */
export function presetSummary(
  t: Translate,
  numbers: LoginPolicyNumbers
): { ip: string; account: string } {
  return {
    ip: t(`${NS}.presetIp`, {
      count: numbers.ipFailThreshold,
      base: durationLabel(t, numbers.ipLockBaseMs),
      max: durationLabel(t, numbers.ipLockMaxMs),
    }),
    account: t(`${NS}.presetAccount`, {
      count: numbers.accountFailPerHour,
      duration: durationLabel(t, numbers.accountLockMs),
    }),
  };
}

export function policiesEqual(a: LoginPolicy, b: LoginPolicy): boolean {
  return (
    a.preset === b.preset &&
    a.exemptLocal === b.exemptLocal &&
    a.ipFailThreshold === b.ipFailThreshold &&
    a.ipLockBaseMs === b.ipLockBaseMs &&
    a.ipLockMaxMs === b.ipLockMaxMs &&
    a.accountFailPerHour === b.accountFailPerHour &&
    a.accountLockMs === b.accountLockMs
  );
}
