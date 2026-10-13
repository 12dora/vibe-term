import { describe, expect, test } from 'bun:test';
import { FileApiError } from '@vibeterm/api-client';
import {
  FILE_NAME_MAX_BYTES,
  fileNameErrorKey,
  fileOpErrorKey,
  splitStem,
  uniqueChildName,
  validateFileName,
} from './file-name';

describe('validateFileName', () => {
  test('普通名称通过，且不做任何 trim', () => {
    expect(validateFileName('notes.txt')).toBeNull();
    expect(validateFileName(' 带空格 ')).toBeNull();
    expect(validateFileName('...')).toBeNull();
  });

  test('空串', () => {
    expect(validateFileName('')).toBe('empty');
  });

  test('`.`、`..`、斜杠、反斜杠、NUL 一律非法', () => {
    for (const name of ['.', '..', 'a/b', 'a\\b', 'a\0b', '/']) {
      expect(validateFileName(name)).toBe('invalid');
    }
  });

  test('按 UTF-8 字节数而不是字符数限长', () => {
    expect(validateFileName('a'.repeat(FILE_NAME_MAX_BYTES))).toBeNull();
    expect(validateFileName('a'.repeat(FILE_NAME_MAX_BYTES + 1))).toBe('tooLong');
    // 一个汉字 3 字节：85 个正好 255，86 个超限
    expect(validateFileName('文'.repeat(85))).toBeNull();
    expect(validateFileName('文'.repeat(86))).toBe('tooLong');
  });
});

describe('fileNameErrorKey', () => {
  test('三种错误各有文案键', () => {
    expect(fileNameErrorKey('empty')).toBe('files.ops.nameEmpty');
    expect(fileNameErrorKey('invalid')).toBe('files.ops.nameInvalid');
    expect(fileNameErrorKey('tooLong')).toBe('files.ops.nameTooLong');
  });
});

describe('uniqueChildName', () => {
  test('未占用时原样返回', () => {
    expect(uniqueChildName('untitled folder', new Set())).toBe('untitled folder');
  });

  test('占用后从 2 开始编号，跳过已占用的编号', () => {
    expect(uniqueChildName('untitled folder', new Set(['untitled folder']))).toBe(
      'untitled folder 2'
    );
    expect(
      uniqueChildName(
        'untitled folder',
        new Set(['untitled folder', 'untitled folder 2', 'untitled folder 3'])
      )
    ).toBe('untitled folder 4');
  });

  test('只有带编号的被占用时仍用原名', () => {
    expect(uniqueChildName('a', new Set(['a 2']))).toBe('a');
  });
});

describe('splitStem', () => {
  test('按最后一个点拆分，扩展名带点', () => {
    expect(splitStem('notes.txt')).toEqual({ stem: 'notes', ext: '.txt' });
    expect(splitStem('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' });
  });

  test('没有点或点文件：扩展名为空', () => {
    expect(splitStem('Makefile')).toEqual({ stem: 'Makefile', ext: '' });
    expect(splitStem('.env')).toEqual({ stem: '.env', ext: '' });
  });

  test('点文件带扩展名、以点结尾', () => {
    expect(splitStem('.env.local')).toEqual({ stem: '.env', ext: '.local' });
    expect(splitStem('name.')).toEqual({ stem: 'name', ext: '.' });
  });
});

describe('fileOpErrorKey', () => {
  test('文件业务错误码映射到 files.error.<code>', () => {
    expect(fileOpErrorKey(new FileApiError(409, 'exists', 'already_exists'))).toBe(
      'files.error.already_exists'
    );
    expect(fileOpErrorKey(new FileApiError(404, 'gone', 'not_found'))).toBe(
      'files.error.not_found'
    );
  });

  test('节点不认识该路由（无业务码的 404）提示升级', () => {
    expect(fileOpErrorKey(new FileApiError(404, 'HTTP 404'))).toBe('files.ops.unsupported');
  });

  test('没有错误码或不是 FileApiError：unknown', () => {
    expect(fileOpErrorKey(new FileApiError(500, 'HTTP 500'))).toBe('files.error.unknown');
    expect(fileOpErrorKey(new Error('boom'))).toBe('files.error.unknown');
    expect(fileOpErrorKey(undefined)).toBe('files.error.unknown');
  });
});
