import { describe, expect, test } from 'bun:test';

import type { TmuxPane } from '../index';
import {
  SOURCE_FIELD_ACTIVE,
  SOURCE_FIELD_CONNECTED,
  SOURCE_FIELD_CURRENT_COMMAND,
  SOURCE_FIELD_CURRENT_PATH,
  SOURCE_FIELD_CUSTOM_NAME,
  SOURCE_FIELD_HEIGHT,
  SOURCE_FIELD_INDEX,
  SOURCE_FIELD_LEFT,
  SOURCE_FIELD_PANE_EPOCH,
  SOURCE_FIELD_TITLE,
  SOURCE_FIELD_TOP,
  SOURCE_FIELD_WIDTH,
} from './canonical-state';
import { PANE_FIELD_SETTERS, applyPaneFields } from './legacy-pane-fields';

function pane(): TmuxPane {
  return {
    id: '%1',
    windowId: '@1',
    index: 0,
    active: false,
    width: 80,
    height: 24,
    left: 1,
    top: 2,
    title: 'title',
    currentPath: '/tmp',
    currentCommand: 'zsh',
    customName: 'named',
  };
}

const CASES: Array<[string, number, string | number | boolean, keyof TmuxPane]> = [
  ['index', SOURCE_FIELD_INDEX, 3, 'index'],
  ['width', SOURCE_FIELD_WIDTH, 120, 'width'],
  ['height', SOURCE_FIELD_HEIGHT, 40, 'height'],
  ['active', SOURCE_FIELD_ACTIVE, true, 'active'],
  ['left', SOURCE_FIELD_LEFT, 11, 'left'],
  ['top', SOURCE_FIELD_TOP, 12, 'top'],
  ['title', SOURCE_FIELD_TITLE, 'new title', 'title'],
  ['currentPath', SOURCE_FIELD_CURRENT_PATH, '/work', 'currentPath'],
  ['currentCommand', SOURCE_FIELD_CURRENT_COMMAND, 'vim', 'currentCommand'],
  ['customName', SOURCE_FIELD_CUSTOM_NAME, 'renamed', 'customName'],
];

const NULLABLE: Array<[string, number, keyof TmuxPane]> = [
  ['left', SOURCE_FIELD_LEFT, 'left'],
  ['top', SOURCE_FIELD_TOP, 'top'],
  ['title', SOURCE_FIELD_TITLE, 'title'],
  ['currentPath', SOURCE_FIELD_CURRENT_PATH, 'currentPath'],
  ['currentCommand', SOURCE_FIELD_CURRENT_COMMAND, 'currentCommand'],
  ['customName', SOURCE_FIELD_CUSTOM_NAME, 'customName'],
];

describe('legacy pane field table', () => {
  test('covers exactly the pane fields carried by the legacy diff', () => {
    expect([...PANE_FIELD_SETTERS.keys()].sort((a, b) => a - b)).toEqual(
      CASES.map(([, field]) => field).sort((a, b) => a - b)
    );
  });

  for (const [name, field, value, key] of CASES) {
    test(`writes ${name}`, () => {
      const target = pane();
      applyPaneFields(target, [[field, value]]);
      expect(target[key]).toEqual(value);
    });
  }

  for (const [name, field, key] of NULLABLE) {
    test(`clears ${name} on null`, () => {
      const target = pane();
      applyPaneFields(target, [[field, null]]);
      expect(key in target).toBe(false);
    });
  }

  test('ignores mismatched value types, unknown fields and epoch-only fields', () => {
    const target = pane();
    applyPaneFields(target, [
      [SOURCE_FIELD_INDEX, 'not-a-number'],
      [SOURCE_FIELD_ACTIVE, 1],
      [SOURCE_FIELD_TITLE, true],
      [SOURCE_FIELD_WIDTH, null],
      [SOURCE_FIELD_CONNECTED, true],
      [SOURCE_FIELD_PANE_EPOCH, 'epoch'],
      [9999, 'unknown'],
    ]);
    expect(target).toEqual(pane());
  });

  test('applies fields in order so the last write wins', () => {
    const target = pane();
    applyPaneFields(target, [
      [SOURCE_FIELD_TITLE, 'first'],
      [SOURCE_FIELD_TITLE, null],
      [SOURCE_FIELD_TITLE, 'last'],
    ]);
    expect(target.title).toBe('last');
  });
});
