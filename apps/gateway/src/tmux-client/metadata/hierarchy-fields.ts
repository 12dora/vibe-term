import { wsBorsh } from '@tmex/shared';

import { type MetadataValue, type PaneFieldHints, stringValue, u16Value, u32Value } from './types';

export function pickFallbackName(
  preferred: string | undefined,
  fallback: string | undefined
): string | undefined {
  return preferred ?? fallback;
}

export function setDefinedStringField(
  fields: Map<number, MetadataValue>,
  field: number,
  value: string | undefined
): void {
  if (value !== undefined) fields.set(field, stringValue(value));
}

export function setTruthyStringField(
  fields: Map<number, MetadataValue>,
  field: number,
  value: string | undefined
): void {
  if (value) fields.set(field, stringValue(value));
}

export function setDefinedU16Field(
  fields: Map<number, MetadataValue>,
  field: number,
  value: number | undefined
): void {
  if (value !== undefined) fields.set(field, u16Value(value));
}

export function setDefinedU32Field(
  fields: Map<number, MetadataValue>,
  field: number,
  value: number | undefined
): void {
  if (value !== undefined) fields.set(field, u32Value(value));
}

export function applyPaneHints(
  fields: Map<number, MetadataValue>,
  hints: PaneFieldHints | undefined
): void {
  if (!hints) return;
  setDefinedStringField(fields, wsBorsh.SOURCE_FIELD_TITLE, hints.title);
  setDefinedStringField(fields, wsBorsh.SOURCE_FIELD_CURRENT_PATH, hints.currentPath);
  setDefinedStringField(fields, wsBorsh.SOURCE_FIELD_CURRENT_COMMAND, hints.currentCommand);
}
