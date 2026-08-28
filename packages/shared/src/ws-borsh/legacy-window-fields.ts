// legacy 快照 diff 的 window / session 字段写入表，与 pane 表共用值类型守卫。

import type { TmuxSession, TmuxWindow } from '../index';
import {
  SOURCE_FIELD_ACTIVE,
  SOURCE_FIELD_CUSTOM_NAME,
  SOURCE_FIELD_INDEX,
  SOURCE_FIELD_LAYOUT,
  SOURCE_FIELD_NAME,
} from './canonical-state';
import {
  type LegacyFieldSetter,
  type LegacyMetadataFields,
  booleanField,
  nullableStringField,
  numberField,
  stringField,
} from './legacy-pane-fields';

type WindowOptionalStringKey = 'layout' | 'customName';

const windowOptionalString = (key: WindowOptionalStringKey): LegacyFieldSetter<TmuxWindow> =>
  nullableStringField((window: TmuxWindow, value) => {
    if (value === null) delete window[key];
    else window[key] = value;
  });

const WINDOW_FIELD_SETTERS: ReadonlyMap<number, LegacyFieldSetter<TmuxWindow>> = new Map<
  number,
  LegacyFieldSetter<TmuxWindow>
>([
  [
    SOURCE_FIELD_NAME,
    stringField((window: TmuxWindow, value) => {
      window.name = value;
    }),
  ],
  [
    SOURCE_FIELD_INDEX,
    numberField((window: TmuxWindow, value) => {
      window.index = value;
    }),
  ],
  [
    SOURCE_FIELD_ACTIVE,
    booleanField((window: TmuxWindow, value) => {
      window.active = value;
    }),
  ],
  [SOURCE_FIELD_LAYOUT, windowOptionalString('layout')],
  [SOURCE_FIELD_CUSTOM_NAME, windowOptionalString('customName')],
]);

const SESSION_FIELD_SETTERS: ReadonlyMap<number, LegacyFieldSetter<TmuxSession>> = new Map<
  number,
  LegacyFieldSetter<TmuxSession>
>([
  [
    SOURCE_FIELD_NAME,
    stringField((session: TmuxSession, value) => {
      session.name = value;
    }),
  ],
]);

export function applyWindowFields(window: TmuxWindow, fields: LegacyMetadataFields): void {
  for (const [field, value] of fields) {
    WINDOW_FIELD_SETTERS.get(field)?.(window, value);
  }
}

export function applySessionFields(session: TmuxSession, fields: LegacyMetadataFields): void {
  for (const [field, value] of fields) {
    SESSION_FIELD_SETTERS.get(field)?.(session, value);
  }
}
