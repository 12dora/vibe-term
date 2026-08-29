import type { TmuxPane, TmuxSession, TmuxWindow } from '../contracts/tmux';
import {
  SOURCE_FIELD_ACTIVE,
  SOURCE_FIELD_CURRENT_COMMAND,
  SOURCE_FIELD_CURRENT_PATH,
  SOURCE_FIELD_CUSTOM_NAME,
  SOURCE_FIELD_HEIGHT,
  SOURCE_FIELD_INDEX,
  SOURCE_FIELD_LAYOUT,
  SOURCE_FIELD_LEFT,
  SOURCE_FIELD_NAME,
  SOURCE_FIELD_TITLE,
  SOURCE_FIELD_TOP,
  SOURCE_FIELD_WIDTH,
} from './canonical-state';
import type { LegacyMetadataFieldValue } from './state-snapshot-diff';

type FieldList = ReadonlyArray<readonly [number, LegacyMetadataFieldValue]>;

interface FieldApplier<T> {
  guard: (value: LegacyMetadataFieldValue) => boolean;
  assign: (target: T, value: LegacyMetadataFieldValue) => void;
}

type FieldTable<T> = Readonly<Partial<Record<number, FieldApplier<T>>>>;

function isString(value: LegacyMetadataFieldValue): value is string {
  return typeof value === 'string';
}

function isNumber(value: LegacyMetadataFieldValue): value is number {
  return typeof value === 'number';
}

function isBoolean(value: LegacyMetadataFieldValue): value is boolean {
  return typeof value === 'boolean';
}

function isStringOrNull(value: LegacyMetadataFieldValue): value is string | null {
  return typeof value === 'string' || value === null;
}

function isNumberOrNull(value: LegacyMetadataFieldValue): value is number | null {
  return typeof value === 'number' || value === null;
}

function defineField<T, V extends LegacyMetadataFieldValue>(
  guard: (value: LegacyMetadataFieldValue) => value is V,
  assign: (target: T, value: V) => void
): FieldApplier<T> {
  return {
    guard,
    assign: (target, value) => {
      if (guard(value)) assign(target, value);
    },
  };
}

function assignOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | null
): void {
  if (value === null) delete target[key];
  else target[key] = value;
}

function applyTypedFields<T>(target: T, fields: FieldList, appliers: FieldTable<T>): void {
  for (const [field, value] of fields) {
    const applier = appliers[field];
    if (!applier) continue;
    if (!applier.guard(value)) continue;
    applier.assign(target, value);
  }
}

const SESSION_FIELD_APPLIERS: FieldTable<TmuxSession> = {
  [SOURCE_FIELD_NAME]: defineField(isString, (session, value) => {
    session.name = value;
  }),
};

const WINDOW_FIELD_APPLIERS: FieldTable<TmuxWindow> = {
  [SOURCE_FIELD_NAME]: defineField(isString, (window, value) => {
    window.name = value;
  }),
  [SOURCE_FIELD_INDEX]: defineField(isNumber, (window, value) => {
    window.index = value;
  }),
  [SOURCE_FIELD_ACTIVE]: defineField(isBoolean, (window, value) => {
    window.active = value;
  }),
  [SOURCE_FIELD_LAYOUT]: defineField(isStringOrNull, (window, value) => {
    assignOptional(window, 'layout', value);
  }),
  [SOURCE_FIELD_CUSTOM_NAME]: defineField(isStringOrNull, (window, value) => {
    assignOptional(window, 'customName', value);
  }),
};

const PANE_FIELD_APPLIERS: FieldTable<TmuxPane> = {
  [SOURCE_FIELD_INDEX]: defineField(isNumber, (pane, value) => {
    pane.index = value;
  }),
  [SOURCE_FIELD_ACTIVE]: defineField(isBoolean, (pane, value) => {
    pane.active = value;
  }),
  [SOURCE_FIELD_WIDTH]: defineField(isNumber, (pane, value) => {
    pane.width = value;
  }),
  [SOURCE_FIELD_HEIGHT]: defineField(isNumber, (pane, value) => {
    pane.height = value;
  }),
  [SOURCE_FIELD_LEFT]: defineField(isNumberOrNull, (pane, value) => {
    assignOptional(pane, 'left', value);
  }),
  [SOURCE_FIELD_TOP]: defineField(isNumberOrNull, (pane, value) => {
    assignOptional(pane, 'top', value);
  }),
  [SOURCE_FIELD_TITLE]: defineField(isStringOrNull, (pane, value) => {
    assignOptional(pane, 'title', value);
  }),
  [SOURCE_FIELD_CURRENT_PATH]: defineField(isStringOrNull, (pane, value) => {
    assignOptional(pane, 'currentPath', value);
  }),
  [SOURCE_FIELD_CURRENT_COMMAND]: defineField(isStringOrNull, (pane, value) => {
    assignOptional(pane, 'currentCommand', value);
  }),
  [SOURCE_FIELD_CUSTOM_NAME]: defineField(isStringOrNull, (pane, value) => {
    assignOptional(pane, 'customName', value);
  }),
};

export function applySessionFields(session: TmuxSession, fields: FieldList): void {
  applyTypedFields(session, fields, SESSION_FIELD_APPLIERS);
}

export function applyWindowFields(window: TmuxWindow, fields: FieldList): void {
  applyTypedFields(window, fields, WINDOW_FIELD_APPLIERS);
}

export function applyPaneFields(pane: TmuxPane, fields: FieldList): void {
  applyTypedFields(pane, fields, PANE_FIELD_APPLIERS);
}
