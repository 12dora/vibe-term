import { describe, expect, test } from 'bun:test';
import { FileApiError } from '@vibeterm/api-client';
import type { TFunction } from 'i18next';
import type { ItemOutcome } from './transfer-batch';
import { summarizeUploadBatch } from './transfer-summary';

const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}${JSON.stringify(opts)}` : key) as unknown as TFunction;

const ok: ItemOutcome = { status: 'done' };
const failed = (code: 'not_found' | 'timeout'): ItemOutcome => ({
  status: 'failed',
  error: new FileApiError(500, code, code),
});

describe('summarizeUploadBatch', () => {
  test('单个文件成功', () => {
    expect(summarizeUploadBatch(['a.txt'], [ok], false, t)).toEqual({
      kind: 'success',
      message: 'files.upload.success{"name":"a.txt"}',
    });
  });

  test('多个文件全部成功', () => {
    expect(summarizeUploadBatch(['a', 'b'], [ok, ok], false, t)).toEqual({
      kind: 'success',
      message: 'files.transfer.uploadedBatch{"count":2}',
    });
  });

  test('单个文件失败：标题沿用旧文案，原因放描述', () => {
    expect(summarizeUploadBatch(['a.txt'], [failed('not_found')], false, t)).toEqual({
      kind: 'failure',
      message: 'files.upload.fail{"name":"a.txt"}',
      description: 'files.error.not_found',
    });
  });

  test('部分失败：只统计失败个数，描述列出原因', () => {
    const result = summarizeUploadBatch(
      ['a', 'b', 'c'],
      [ok, failed('timeout'), failed('not_found')],
      false,
      t
    );
    expect(result).toEqual({
      kind: 'failure',
      message: 'files.transfer.uploadBatchFailed{"count":2}',
      description: 'b: files.error.timeout\nc: files.error.not_found',
    });
  });

  test('用户取消优先于一切', () => {
    expect(
      summarizeUploadBatch(['a', 'b'], [failed('timeout'), { status: 'cancelled' }], true, t)
    ).toEqual({ kind: 'cancel' });
  });
});
