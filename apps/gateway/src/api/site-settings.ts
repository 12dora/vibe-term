import {
  SITE_SETTING_FIELDS,
  type SiteSettingField,
  type SiteSettingFieldDef,
  type SiteSettings,
  type UpdateSiteSettingsRequest,
} from '@vibeterm/shared';
import { t } from '../i18n';

export type SiteSettingsUpdates = Partial<Omit<SiteSettings, 'updatedAt'>>;

function asDef(field: SiteSettingField): SiteSettingFieldDef {
  return field;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(t('apiError.invalidRequest'));
  }
  return value;
}

function errorOf(field: SiteSettingFieldDef): string {
  return t(field.errorCode ? `apiError.${field.errorCode}` : 'apiError.invalidRequest');
}

function normalizeStringValue(field: SiteSettingFieldDef, raw: unknown): string {
  const value = (raw as string).trim();
  if (field.kind === 'string' && field.nonempty && !value) throw new Error(errorOf(field));
  if (field.kind === 'string' && field.httpUrl && !/^https?:\/\//i.test(value)) {
    throw new Error(errorOf(field));
  }
  return value;
}

function normalizeIntValue(field: SiteSettingFieldDef, raw: unknown): number {
  if (field.kind !== 'int') throw new Error(t('apiError.invalidRequest'));
  const value = Math.floor(Number(raw));
  if (Number.isNaN(value) || value < field.min || value > field.max) {
    throw new Error(errorOf(field));
  }
  return value;
}

function normalizeEnumValue(field: SiteSettingFieldDef, raw: unknown): string {
  const value = (raw as string).trim();
  if (field.kind !== 'enum' || !(field.values as readonly string[]).includes(value)) {
    throw new Error(errorOf(field));
  }
  return value;
}

function normalizeStringsValue(field: SiteSettingFieldDef, raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) {
    throw new Error(t('apiError.invalidRequest'));
  }
  const mapped = field.kind === 'strings' && field.trim ? raw.map((item) => item.trim()) : raw;
  const nonempty = mapped.filter(Boolean);
  return field.kind === 'strings' && field.unique ? [...new Set(nonempty)] : nonempty;
}

function normalizePatchField(field: SiteSettingField, raw: unknown): unknown {
  const def = asDef(field);
  switch (def.kind) {
    case 'string':
    case 'secret':
      return normalizeStringValue(def, raw);
    case 'bool':
      return requireBoolean(raw);
    case 'int':
      return normalizeIntValue(def, raw);
    case 'enum':
      return normalizeEnumValue(def, raw);
    case 'strings':
      return normalizeStringsValue(def, raw);
    default: {
      const _never: never = def;
      return _never;
    }
  }
}

export function normalizeSiteSettingsInput(body: UpdateSiteSettingsRequest): SiteSettingsUpdates {
  const updates: SiteSettingsUpdates = {};
  for (const field of SITE_SETTING_FIELDS) {
    if (!field.patch) continue;
    const raw = (body as Record<string, unknown>)[field.key];
    if (raw === undefined) continue;
    (updates as Record<string, unknown>)[field.key] = normalizePatchField(field, raw);
  }
  return updates;
}
