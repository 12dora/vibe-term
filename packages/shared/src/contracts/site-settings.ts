// 站点设置契约。字段以 SITE_SETTING_FIELDS 为单一真源：
// 契约类型、PATCH 归一化、merge、CLI key/旗标/USAGE 行均从此表派生。

import { AVAILABLE_LOCALES, DEFAULT_LOCALE, type LocaleCode } from '../i18n/resources';
import type { ShareOriginCandidate } from '../share/types';

export const THEME_MODES = ['dark', 'light'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const SITE_SETTING_FIELD_KINDS = [
  'string',
  'bool',
  'int',
  'secret',
  'enum',
  'strings',
] as const;
export type SiteSettingFieldKind = (typeof SITE_SETTING_FIELD_KINDS)[number];

type FieldBase<K extends string, Kind extends SiteSettingFieldKind, D> = {
  readonly key: K;
  readonly kind: Kind;
  readonly default: D;
  /** `vibeterm settings site set` 的键名；null 表示不进 CLI */
  readonly cliFlag: string | null;
  /** 是否出现在 UpdateSiteSettingsRequest / PATCH 归一化 */
  readonly patch: boolean;
  /** 校验失败对应的 apiError.* 码（不带前缀）：完整 i18n key 由网关拼出，避免 rest 包 key 字面量进入前端入口图。 */
  readonly errorCode?: string;
};

export type SiteSettingFieldDef =
  | (FieldBase<string, 'string', string> & {
      trim?: boolean;
      nonempty?: boolean;
      httpUrl?: boolean;
    })
  | (FieldBase<string, 'secret', string> & { trim?: boolean })
  | FieldBase<string, 'bool', boolean>
  | (FieldBase<string, 'int', number> & { min: number; max: number })
  | (FieldBase<string, 'enum', string> & { values: readonly string[] })
  | (FieldBase<string, 'strings', readonly string[]> & { trim?: boolean; unique?: boolean });

export const SITE_SETTING_FIELDS = [
  {
    key: 'siteName',
    kind: 'string',
    default: 'VibeTerm',
    cliFlag: 'siteName',
    patch: true,
    trim: true,
    nonempty: true,
    errorCode: 'siteNameRequired',
  },
  {
    key: 'siteUrl',
    kind: 'string',
    default: '',
    cliFlag: 'siteUrl',
    patch: true,
    trim: true,
    httpUrl: true,
    errorCode: 'siteUrlInvalid',
  },
  {
    key: 'bellThrottleSeconds',
    kind: 'int',
    default: 6,
    cliFlag: 'bellThrottleSeconds',
    patch: true,
    min: 0,
    max: 300,
    errorCode: 'bellThrottleInvalid',
  },
  {
    key: 'notificationThrottleSeconds',
    kind: 'int',
    default: 3,
    cliFlag: 'notificationThrottleSeconds',
    patch: true,
    min: 0,
    max: 300,
    errorCode: 'bellThrottleInvalid',
  },
  {
    key: 'enableBrowserNotificationToast',
    kind: 'bool',
    default: true,
    cliFlag: 'enableBrowserNotificationToast',
    patch: true,
  },
  {
    key: 'enableNotificationPush',
    kind: 'bool',
    default: true,
    cliFlag: 'enableNotificationPush',
    patch: true,
  },
  {
    key: 'enableBellPush',
    kind: 'bool',
    default: true,
    cliFlag: 'enableBellPush',
    patch: true,
  },
  {
    key: 'enableBellSound',
    kind: 'bool',
    default: true,
    cliFlag: 'enableBellSound',
    patch: true,
  },
  {
    key: 'sshReconnectMaxRetries',
    kind: 'int',
    default: 2,
    cliFlag: 'sshReconnectMaxRetries',
    patch: true,
    min: 0,
    max: 20,
    errorCode: 'sshRetriesInvalid',
  },
  {
    key: 'sshReconnectDelaySeconds',
    kind: 'int',
    default: 10,
    cliFlag: 'sshReconnectDelaySeconds',
    patch: true,
    min: 1,
    max: 300,
    errorCode: 'sshDelayInvalid',
  },
  {
    key: 'language',
    kind: 'enum',
    default: DEFAULT_LOCALE,
    cliFlag: 'language',
    patch: true,
    values: AVAILABLE_LOCALES,
    errorCode: 'languageInvalid',
  },
  {
    key: 'theme',
    kind: 'enum',
    default: 'dark',
    cliFlag: null,
    patch: false,
    values: THEME_MODES,
  },
  {
    key: 'disabledNotificationChannels',
    kind: 'strings',
    default: [],
    cliFlag: 'disabledNotificationChannels',
    patch: true,
    trim: true,
    unique: true,
  },
  {
    key: 'updatedAt',
    kind: 'string',
    default: '',
    cliFlag: null,
    patch: false,
  },
] as const satisfies readonly SiteSettingFieldDef[];

export type SiteSettingField = (typeof SITE_SETTING_FIELDS)[number];
export type SiteSettingKey = SiteSettingField['key'];

type FieldValue<F> = F extends { kind: 'string' } | { kind: 'secret' }
  ? string
  : F extends { kind: 'bool' }
    ? boolean
    : F extends { kind: 'int' }
      ? number
      : F extends { kind: 'strings' }
        ? string[]
        : F extends { kind: 'enum'; values: readonly (infer V)[] }
          ? V
          : never;

export type SiteSettings = {
  [F in SiteSettingField as F['key']]: F['key'] extends 'language' ? LocaleCode : FieldValue<F>;
};

export type UpdateSiteSettingsRequest = {
  [F in SiteSettingField as F extends { patch: true }
    ? F['key']
    : never]?: F['key'] extends 'language' ? LocaleCode : FieldValue<F>;
};

export const SITE_SETTING_KEYS: readonly SiteSettingKey[] = SITE_SETTING_FIELDS.map(
  (field) => field.key
);

export const SITE_SETTING_CLI_KEYS: readonly string[] = SITE_SETTING_FIELDS.flatMap((field) =>
  field.cliFlag === null ? [] : [field.cliFlag]
);

/** `vibeterm settings` 中站点子命令的 USAGE 行，文案与既有帮助保持一致。 */
export const SITE_SETTING_CLI_USAGE_LINES = [
  '  site get|set <key> <value>     GET/PATCH /api/settings/site',
] as const;

type CliFlagKind = 'boolean' | 'string' | 'number' | 'strings';

function cliKindOf(kind: SiteSettingFieldKind): CliFlagKind {
  if (kind === 'bool') return 'boolean';
  if (kind === 'int') return 'number';
  if (kind === 'strings') return 'strings';
  return 'string';
}

/** 由 secret 字段派生 `--flag` / `--flag-stdin` / `--flag-file` 三件套；当前站点字段无 secret。 */
export function siteSettingSecretFlags(): Record<string, 'string' | 'boolean'> {
  const spec: Record<string, 'string' | 'boolean'> = {};
  for (const field of SITE_SETTING_FIELDS as readonly SiteSettingFieldDef[]) {
    if (field.kind !== 'secret' || field.cliFlag === null) continue;
    spec[field.cliFlag] = 'string';
    spec[`${field.cliFlag}-stdin`] = 'boolean';
    spec[`${field.cliFlag}-file`] = 'string';
  }
  return spec;
}

export const SITE_SETTING_SECRET_FLAGS: Record<string, 'string' | 'boolean'> =
  siteSettingSecretFlags();

export function siteSettingCliFlagSpec(): Record<string, CliFlagKind> {
  const spec: Record<string, CliFlagKind> = { ...SITE_SETTING_SECRET_FLAGS };
  for (const field of SITE_SETTING_FIELDS as readonly SiteSettingFieldDef[]) {
    if (field.cliFlag === null || field.kind === 'secret') continue;
    spec[field.cliFlag] = cliKindOf(field.kind);
  }
  return spec;
}

/** mesh 运行态投影：站点访问 URL / 显示名是否由节点身份托管。 */
export interface SiteSettingsLinkFields {
  /** 用户实际应使用的访问 URL；standalone 等于存储的 siteUrl。 */
  effectiveSiteUrl: string | null;
  /** mesh（hub 或 node）下为 false，站点 URL 由运行时决定。 */
  siteUrlEditable: boolean;
  /** mesh 下为 true：站点名与本机 mesh 节点名同步。 */
  siteNameLinkedToNode: boolean;
  /** mesh 下为本机 node id，standalone 为 null。 */
  nodeId: string | null;
  /** 本机当前可被访问的公网地址候选（与分享地址候选同源、同序）。 */
  siteAccessOrigins: ShareOriginCandidate[];
}

export type SiteSettingsView = SiteSettings & SiteSettingsLinkFields;

export interface GetSiteSettingsResponse extends SiteSettingsLinkFields {
  settings: SiteSettingsView;
}
