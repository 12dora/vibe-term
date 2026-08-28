// legacy 快照 diff 的 pane 字段写入表：按 SOURCE_FIELD_* 编号分发，值类型不匹配时忽略该字段。

import type { TmuxPane } from '../index';
import {
  SOURCE_FIELD_ACTIVE,
  SOURCE_FIELD_CURRENT_COMMAND,
  SOURCE_FIELD_CURRENT_PATH,
  SOURCE_FIELD_CUSTOM_NAME,
  SOURCE_FIELD_HEIGHT,
  SOURCE_FIELD_INDEX,
  SOURCE_FIELD_LEFT,
  SOURCE_FIELD_TITLE,
  SOURCE_FIELD_TOP,
  SOURCE_FIELD_WIDTH,
} from './canonical-state';

export type LegacyMetadataFieldValue = string | number | boolean | null;
export type LegacyMetadataFields = ReadonlyArray<readonly [number, LegacyMetadataFieldValue]>;
export type LegacyFieldSetter<T> = (target: T, value: LegacyMetadataFieldValue) => void;

export function numberField<T>(write: (target: T, value: number) => void): LegacyFieldSetter<T> {
  return (target, value) => {
    if (typeof value === 'number') write(target, value);
  };
}

export function booleanField<T>(write: (target: T, value: boolean) => void): LegacyFieldSetter<T> {
  return (target, value) => {
    if (typeof value === 'boolean') write(target, value);
  };
}

export function stringField<T>(write: (target: T, value: string) => void): LegacyFieldSetter<T> {
  return (target, value) => {
    if (typeof value === 'string') write(target, value);
  };
}

export function nullableNumberField<T>(
  write: (target: T, value: number | null) => void
): LegacyFieldSetter<T> {
  return (target, value) => {
    if (value === null || typeof value === 'number') write(target, value);
  };
}

export function nullableStringField<T>(
  write: (target: T, value: string | null) => void
): LegacyFieldSetter<T> {
  return (target, value) => {
    if (value === null || typeof value === 'string') write(target, value);
  };
}

type PaneNumberKey = 'index' | 'width' | 'height';
type PaneOptionalNumberKey = 'left' | 'top';
type PaneOptionalStringKey = 'title' | 'currentPath' | 'currentCommand' | 'customName';

const paneNumber = (key: PaneNumberKey): LegacyFieldSetter<TmuxPane> =>
  numberField((pane: TmuxPane, value) => {
    pane[key] = value;
  });

const paneBoolean = (key: 'active'): LegacyFieldSetter<TmuxPane> =>
  booleanField((pane: TmuxPane, value) => {
    pane[key] = value;
  });

const paneOptionalNumber = (key: PaneOptionalNumberKey): LegacyFieldSetter<TmuxPane> =>
  nullableNumberField((pane: TmuxPane, value) => {
    if (value === null) delete pane[key];
    else pane[key] = value;
  });

const paneOptionalString = (key: PaneOptionalStringKey): LegacyFieldSetter<TmuxPane> =>
  nullableStringField((pane: TmuxPane, value) => {
    if (value === null) delete pane[key];
    else pane[key] = value;
  });

export const PANE_FIELD_SETTERS: ReadonlyMap<number, LegacyFieldSetter<TmuxPane>> = new Map<
  number,
  LegacyFieldSetter<TmuxPane>
>([
  [SOURCE_FIELD_INDEX, paneNumber('index')],
  [SOURCE_FIELD_WIDTH, paneNumber('width')],
  [SOURCE_FIELD_HEIGHT, paneNumber('height')],
  [SOURCE_FIELD_ACTIVE, paneBoolean('active')],
  [SOURCE_FIELD_LEFT, paneOptionalNumber('left')],
  [SOURCE_FIELD_TOP, paneOptionalNumber('top')],
  [SOURCE_FIELD_TITLE, paneOptionalString('title')],
  [SOURCE_FIELD_CURRENT_PATH, paneOptionalString('currentPath')],
  [SOURCE_FIELD_CURRENT_COMMAND, paneOptionalString('currentCommand')],
  [SOURCE_FIELD_CUSTOM_NAME, paneOptionalString('customName')],
]);

export function applyPaneFields(pane: TmuxPane, fields: LegacyMetadataFields): void {
  for (const [field, value] of fields) {
    PANE_FIELD_SETTERS.get(field)?.(pane, value);
  }
}
