import { describe, expect, test } from 'bun:test';
import type { FileEntryDto } from '@vibeterm/shared';
import {
  entryKindKey,
  filterEntries,
  isDirectoryEntry,
  isHiddenName,
  sortEntries,
  toEntryView,
  typeAheadMatch,
} from './entries';

function entry(name: string, patch: Partial<FileEntryDto> = {}): FileEntryDto {
  return {
    name,
    path: `/root/${name}`,
    type: 'file',
    category: 'text',
    size: 1,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    isSymlink: false,
    ...patch,
  };
}

function dir(name: string, patch: Partial<FileEntryDto> = {}): FileEntryDto {
  return entry(name, { type: 'dir', category: 'directory', size: null, ...patch });
}

const names = (entries: readonly FileEntryDto[]) => entries.map((item) => item.name);

const FIXTURE: readonly FileEntryDto[] = [
  entry('file10.txt', { size: 5, modifiedAt: '2026-01-03T00:00:00.000Z' }),
  dir('b'),
  entry('Zed.md', { category: 'markdown', size: null, modifiedAt: null }),
  entry('link', { type: 'symlink', category: 'directory', size: null, isSymlink: true }),
  entry('file2.txt', { size: 50, modifiedAt: '2026-01-01T00:00:00.000Z' }),
  dir('A'),
];

describe('isHiddenName', () => {
  test('dotfiles are hidden', () => {
    expect(isHiddenName('.env')).toBe(true);
    expect(isHiddenName('env')).toBe(false);
    expect(isHiddenName('a.b')).toBe(false);
  });
});

describe('isDirectoryEntry', () => {
  test('directories and symlinks to directories', () => {
    expect(isDirectoryEntry(dir('a'))).toBe(true);
    expect(isDirectoryEntry(entry('l', { type: 'symlink', category: 'directory' }))).toBe(true);
  });

  test('files and symlinks to files are not', () => {
    expect(isDirectoryEntry(entry('a'))).toBe(false);
    expect(isDirectoryEntry(entry('l', { type: 'symlink', category: 'code' }))).toBe(false);
    expect(isDirectoryEntry(entry('o', { type: 'other', category: 'other' }))).toBe(false);
  });
});

describe('entryKindKey / toEntryView', () => {
  test('uses the category, symlinks get their own key', () => {
    expect(entryKindKey(entry('a.md', { category: 'markdown' }))).toBe('explorer.kind.markdown');
    expect(entryKindKey(dir('a'))).toBe('explorer.kind.directory');
    expect(entryKindKey(entry('l', { type: 'symlink', category: 'directory' }))).toBe(
      'explorer.kind.symlink'
    );
    expect(entryKindKey(entry('l', { isSymlink: true }))).toBe('explorer.kind.symlink');
  });

  test('builds the view model', () => {
    const hidden = entry('.env');
    expect(toEntryView(hidden)).toEqual({
      entry: hidden,
      hidden: true,
      kindKey: 'explorer.kind.text',
    });
    expect(toEntryView(dir('src')).hidden).toBe(false);
  });
});

describe('sortEntries', () => {
  test('name: directories first, numeric and case-insensitive', () => {
    expect(names(sortEntries(FIXTURE, { key: 'name', dir: 'asc' }))).toEqual([
      'A',
      'b',
      'link',
      'file2.txt',
      'file10.txt',
      'Zed.md',
    ]);
  });

  test('name desc reverses inside each group only', () => {
    expect(names(sortEntries(FIXTURE, { key: 'name', dir: 'desc' }))).toEqual([
      'link',
      'b',
      'A',
      'Zed.md',
      'file10.txt',
      'file2.txt',
    ]);
  });

  test('size: null sizes last in both directions, ties by name asc', () => {
    expect(names(sortEntries(FIXTURE, { key: 'size', dir: 'asc' }))).toEqual([
      'A',
      'b',
      'link',
      'file10.txt',
      'file2.txt',
      'Zed.md',
    ]);
    expect(names(sortEntries(FIXTURE, { key: 'size', dir: 'desc' }))).toEqual([
      'A',
      'b',
      'link',
      'file2.txt',
      'file10.txt',
      'Zed.md',
    ]);
  });

  test('modifiedAt: null and unparsable dates last', () => {
    const entries = [
      entry('new', { modifiedAt: '2026-03-01T00:00:00.000Z' }),
      entry('none', { modifiedAt: null }),
      entry('broken', { modifiedAt: 'not a date' }),
      entry('old', { modifiedAt: '2025-03-01T00:00:00.000Z' }),
    ];
    expect(names(sortEntries(entries, { key: 'modifiedAt', dir: 'asc' }))).toEqual([
      'old',
      'new',
      'broken',
      'none',
    ]);
    expect(names(sortEntries(entries, { key: 'modifiedAt', dir: 'desc' }))).toEqual([
      'new',
      'old',
      'broken',
      'none',
    ]);
  });

  test('kind: by category, then name asc', () => {
    expect(names(sortEntries(FIXTURE, { key: 'kind', dir: 'asc' }))).toEqual([
      'A',
      'b',
      'link',
      'Zed.md',
      'file2.txt',
      'file10.txt',
    ]);
    expect(names(sortEntries(FIXTURE, { key: 'kind', dir: 'desc' }))).toEqual([
      'A',
      'b',
      'link',
      'file2.txt',
      'file10.txt',
      'Zed.md',
    ]);
  });

  test('is stable and does not mutate the input', () => {
    const first = entry('same', { path: '/root/x/same' });
    const second = entry('same', { path: '/root/y/same' });
    const input = [first, second];
    const sorted = sortEntries(input, { key: 'name', dir: 'desc' });
    expect(sorted).not.toBe(input);
    expect(sorted[0]).toBe(first);
    expect(sorted[1]).toBe(second);
    expect(names(FIXTURE)[0]).toBe('file10.txt');
  });
});

describe('filterEntries', () => {
  const entries = [entry('.env'), entry('README.md'), dir('.git'), dir('src'), entry('read.ts')];

  test('drops dotfiles unless showHidden', () => {
    expect(names(filterEntries(entries, { showHidden: false, query: '' }))).toEqual([
      'README.md',
      'src',
      'read.ts',
    ]);
    expect(filterEntries(entries, { showHidden: true, query: '' })).toHaveLength(5);
  });

  test('query is a case-insensitive substring', () => {
    expect(names(filterEntries(entries, { showHidden: false, query: 'READ' }))).toEqual([
      'README.md',
      'read.ts',
    ]);
    expect(names(filterEntries(entries, { showHidden: true, query: 'e' }))).toEqual([
      '.env',
      'README.md',
      'read.ts',
    ]);
    expect(names(filterEntries(entries, { showHidden: false, query: '  src ' }))).toEqual(['src']);
    expect(filterEntries(entries, { showHidden: true, query: 'zzz' })).toEqual([]);
  });
});

describe('typeAheadMatch', () => {
  const entries = [entry('alpha'), entry('Beta'), entry('bravo'), entry('charlie')];

  test('finds the first match at or after fromIndex', () => {
    expect(typeAheadMatch(entries, 'b', 0)).toBe(1);
    expect(typeAheadMatch(entries, 'B', 2)).toBe(2);
    expect(typeAheadMatch(entries, 'br', 0)).toBe(2);
  });

  test('wraps around the end', () => {
    expect(typeAheadMatch(entries, 'b', 3)).toBe(1);
    expect(typeAheadMatch(entries, 'a', 1)).toBe(0);
    expect(typeAheadMatch(entries, 'b', 4)).toBe(1);
    expect(typeAheadMatch(entries, 'c', -1)).toBe(3);
  });

  test('returns -1 without a match, prefix or entries', () => {
    expect(typeAheadMatch(entries, 'z', 0)).toBe(-1);
    expect(typeAheadMatch(entries, '', 0)).toBe(-1);
    expect(typeAheadMatch([], 'a', 0)).toBe(-1);
    expect(typeAheadMatch(entries, 'a', Number.NaN)).toBe(0);
  });
});
