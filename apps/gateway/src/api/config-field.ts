export type FieldParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type AbsentAction<T, Ctx> = 'omit' | 'parse' | { default: T | ((ctx: Ctx) => T) };

export interface ConfigFieldSpec<T, Ctx = unknown> {
  name: string;
  parse: (raw: unknown, ctx: Ctx) => FieldParseResult<T>;
  onAbsent?: AbsentAction<T, Ctx> | ((ctx: Ctx) => AbsentAction<T, Ctx>);
  nullIsAbsent?: boolean | ((ctx: Ctx) => boolean);
}

function isAbsent<T, Ctx>(raw: unknown, spec: ConfigFieldSpec<T, Ctx>, ctx: Ctx): boolean {
  if (raw === undefined) return true;
  if (raw !== null) return false;
  const flag = spec.nullIsAbsent;
  return typeof flag === 'function' ? flag(ctx) : Boolean(flag);
}

function resolveOnAbsent<T, Ctx>(spec: ConfigFieldSpec<T, Ctx>, ctx: Ctx): AbsentAction<T, Ctx> {
  const action = spec.onAbsent;
  if (action === undefined) return 'omit';
  return typeof action === 'function' ? action(ctx) : action;
}

export function applyConfigFields<T extends object, Ctx = unknown>(
  body: Record<string, unknown>,
  specs: readonly ConfigFieldSpec<unknown, Ctx>[],
  ctx: Ctx
): { ok: true; fields: T } | { ok: false; error: string } {
  const fields = {} as T;
  const liveCtx = { ...ctx, fields } as Ctx;
  for (const spec of specs) {
    const raw = body[spec.name];
    const absent = isAbsent(raw, spec, liveCtx);
    if (absent) {
      const action = resolveOnAbsent(spec, liveCtx);
      if (action === 'omit') continue;
      if (action !== 'parse') {
        const value =
          typeof action.default === 'function' ? action.default(liveCtx) : action.default;
        (fields as Record<string, unknown>)[spec.name] = value;
        continue;
      }
    }
    const parsed = spec.parse(raw, liveCtx);
    if (!parsed.ok) return parsed;
    (fields as Record<string, unknown>)[spec.name] = parsed.value;
  }
  return { ok: true, fields };
}

export function parseBooleanField(raw: unknown, error: string): FieldParseResult<boolean> {
  if (typeof raw !== 'boolean') return { ok: false, error };
  return { ok: true, value: raw };
}

export function parseEnumField<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  error: string
): FieldParseResult<T> {
  if (!allowed.includes(raw as T)) return { ok: false, error };
  return { ok: true, value: raw as T };
}

export function parseIntegerField(
  raw: unknown,
  error: string,
  extra?: (n: number) => boolean
): FieldParseResult<number> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || extra?.(raw) === false) {
    return { ok: false, error };
  }
  return { ok: true, value: raw };
}

export function parseStringArrayField(raw: unknown, error: string): FieldParseResult<string[]> {
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) {
    return { ok: false, error };
  }
  return { ok: true, value: raw };
}

export function uniqueTrimmedStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}
