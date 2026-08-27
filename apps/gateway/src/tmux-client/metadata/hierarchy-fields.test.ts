import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';

import {
  applyPaneHints,
  pickFallbackName,
  setDefinedStringField,
  setDefinedU16Field,
  setTruthyStringField,
} from './hierarchy-fields';
import type { MetadataValue } from './types';

describe('pickFallbackName', () => {
  test.each([
    { name: 'preferred wins', preferred: 'host', fallback: 'snap', expected: 'host' },
    {
      name: 'fallback when preferred is missing',
      preferred: undefined,
      fallback: 'snap',
      expected: 'snap',
    },
    { name: 'both missing', preferred: undefined, fallback: undefined, expected: undefined },
    {
      name: 'empty preferred is kept over fallback',
      preferred: '',
      fallback: 'snap',
      expected: '',
    },
    {
      name: 'preferred without fallback',
      preferred: 'host',
      fallback: undefined,
      expected: 'host',
    },
  ])('$name', ({ preferred, fallback, expected }) => {
    expect(pickFallbackName(preferred, fallback)).toBe(expected);
  });
});

describe('optional field writers', () => {
  test.each([
    {
      name: 'defined string writes empty values',
      run: (fields: Map<number, MetadataValue>) =>
        setDefinedStringField(fields, wsBorsh.SOURCE_FIELD_TITLE, ''),
      expected: new Map([[wsBorsh.SOURCE_FIELD_TITLE, { String: '' }]]),
    },
    {
      name: 'defined string skips undefined',
      run: (fields: Map<number, MetadataValue>) =>
        setDefinedStringField(fields, wsBorsh.SOURCE_FIELD_TITLE, undefined),
      expected: new Map(),
    },
    {
      name: 'truthy string skips empty custom names',
      run: (fields: Map<number, MetadataValue>) =>
        setTruthyStringField(fields, wsBorsh.SOURCE_FIELD_CUSTOM_NAME, ''),
      expected: new Map(),
    },
    {
      name: 'truthy string writes a non-empty custom name',
      run: (fields: Map<number, MetadataValue>) =>
        setTruthyStringField(fields, wsBorsh.SOURCE_FIELD_CUSTOM_NAME, 'win'),
      expected: new Map([[wsBorsh.SOURCE_FIELD_CUSTOM_NAME, { String: 'win' }]]),
    },
    {
      name: 'defined u16 writes zero and skips undefined',
      run: (fields: Map<number, MetadataValue>) => {
        setDefinedU16Field(fields, wsBorsh.SOURCE_FIELD_LEFT, 0);
        setDefinedU16Field(fields, wsBorsh.SOURCE_FIELD_TOP, undefined);
      },
      expected: new Map([[wsBorsh.SOURCE_FIELD_LEFT, { U16: 0 }]]),
    },
  ])('$name', ({ run, expected }) => {
    const fields = new Map<number, MetadataValue>();
    run(fields);
    expect(fields).toEqual(expected);
  });
});

describe('applyPaneHints', () => {
  test.each([
    {
      name: 'ignores missing hints',
      hints: undefined,
      seedTitle: 'shell',
      expectedTitle: 'shell',
      expectedPath: undefined,
    },
    {
      name: 'overrides title and fills path/command',
      hints: { title: 'hinted', currentPath: '/tmp', currentCommand: 'zsh' },
      seedTitle: 'shell',
      expectedTitle: 'hinted',
      expectedPath: '/tmp',
    },
    {
      name: 'empty hint title overrides a snapshot title',
      hints: { title: '' },
      seedTitle: 'shell',
      expectedTitle: '',
      expectedPath: undefined,
    },
  ])('$name', ({ hints, seedTitle, expectedTitle, expectedPath }) => {
    const fields = new Map<number, MetadataValue>([
      [wsBorsh.SOURCE_FIELD_TITLE, { String: seedTitle }],
    ]);
    applyPaneHints(fields, hints);
    expect(fields.get(wsBorsh.SOURCE_FIELD_TITLE)).toEqual({ String: expectedTitle });
    expect(fields.get(wsBorsh.SOURCE_FIELD_CURRENT_PATH)).toEqual(
      expectedPath === undefined ? undefined : { String: expectedPath }
    );
    if (hints?.currentCommand !== undefined) {
      expect(fields.get(wsBorsh.SOURCE_FIELD_CURRENT_COMMAND)).toEqual({
        String: hints.currentCommand,
      });
    }
  });
});
