import { describe, expect, test } from 'bun:test';
import { ApiError, FileApiError, TransferInterruptedError } from '@vibeterm/api-client';
import type { TFunction } from 'i18next';
import {
  SaveFileError,
  describeBatchFailures,
  describeTransferError,
  isAbortError,
} from './transfer-errors';

// t 回 key 本身，断言的就是「选了哪条文案」
const t = ((key: string) => key) as unknown as TFunction;

describe('describeTransferError', () => {
  test('用户取消返回空串，交给调用方按取消处理', () => {
    const abort = new DOMException('Aborted', 'AbortError');
    expect(isAbortError(abort)).toBe(true);
    expect(describeTransferError(abort, t)).toBe('');
  });

  test('链路中断', () => {
    const error = new TransferInterruptedError(10, 100, new TypeError('fetch failed'));
    expect(describeTransferError(error, t)).toBe('files.transfer.error.network');
  });

  test('需要登录该节点：401 或转发层错误码', () => {
    expect(describeTransferError(new FileApiError(401, 'HTTP 401'), t)).toBe(
      'files.transfer.error.login_required'
    );
    expect(
      describeTransferError(
        new FileApiError(403, 'login', 'NODE_LOGIN_REQUIRED' as unknown as 'invalid'),
        t
      )
    ).toBe('files.transfer.error.login_required');
  });

  test('超过传输上限不借用预览的「无法预览」文案', () => {
    const error = new FileApiError(413, 'too big', 'too_large', '2147483648');
    expect(describeTransferError(error, t)).toBe('files.transfer.error.too_large');
  });

  test('传输期间源文件变化', () => {
    const error = new FileApiError(400, 'source changed', 'invalid', 'source changed');
    expect(describeTransferError(error, t)).toBe('files.transfer.error.source_changed');
  });

  test('其它 invalid 走通用文件错误文案', () => {
    expect(describeTransferError(new FileApiError(400, 'bad', 'invalid', 'other'), t)).toBe(
      'files.error.invalid'
    );
  });

  test('宿主保存失败', () => {
    expect(describeTransferError(new SaveFileError(new Error('quota')), t)).toBe(
      'files.transfer.error.save_failed'
    );
  });

  test.each([
    ['not_found', 'files.error.not_found'],
    ['permission_denied', 'files.error.permission_denied'],
    ['connection_failed', 'files.error.connection_failed'],
    ['timeout', 'files.error.timeout'],
    ['rsync_missing_remote', 'files.error.rsync_missing_remote'],
    ['is_directory', 'files.error.is_directory'],
  ] as const)('已知错误码 %s', (code, key) => {
    expect(describeTransferError(new FileApiError(500, code, code), t)).toBe(key);
  });

  test('binary 是预览专用文案，传输里不使用', () => {
    expect(describeTransferError(new FileApiError(415, 'binary', 'binary'), t)).toBe(
      'common.unknown'
    );
  });

  test('网络层失败（fetch 抛 TypeError）按链路中断处理', () => {
    expect(describeTransferError(new TypeError('Failed to fetch'), t)).toBe(
      'files.transfer.error.network'
    );
  });

  test('转发层打不通目标节点（503 NODE_UNREACHABLE），FileApiError 与 ApiError 同样处理', () => {
    const code = 'NODE_UNREACHABLE' as unknown as 'unknown';
    expect(describeTransferError(new FileApiError(503, 'x', code), t)).toBe(
      'devices.transfer.errors.node_unreachable'
    );
    expect(describeTransferError(new ApiError(503, 'x', { code: 'NODE_UNREACHABLE' }), t)).toBe(
      'devices.transfer.errors.node_unreachable'
    );
  });

  test('没有业务错误码的 5xx（代理 / 网关层失败）按链路问题处理', () => {
    expect(describeTransferError(new FileApiError(502, 'HTTP 502'), t)).toBe(
      'files.transfer.error.network'
    );
    expect(describeTransferError(new ApiError(504, 'Gateway Timeout'), t)).toBe(
      'files.transfer.error.network'
    );
    // 带业务错误码的 5xx 仍按错误码给原因
    expect(describeTransferError(new FileApiError(502, 'x', 'connection_failed'), t)).toBe(
      'files.error.connection_failed'
    );
  });

  test('ApiError 形态的 401 也提示需要登录', () => {
    expect(describeTransferError(new ApiError(401, 'x', { code: 'NODE_LOGIN_REQUIRED' }), t)).toBe(
      'files.transfer.error.login_required'
    );
  });

  test('不认识的错误一律「未知」，不外露英文原始文案', () => {
    expect(describeTransferError(new Error('Disk is full'), t)).toBe('common.unknown');
    expect(describeTransferError(new Error('磁盘已满'), t)).toBe('common.unknown');
    expect(describeTransferError(new Error('bulk_size_mismatch:1/2'), t)).toBe('common.unknown');
    expect(describeTransferError(new FileApiError(500, 'Internal failure', 'unknown'), t)).toBe(
      'common.unknown'
    );
    expect(describeTransferError('oops', t)).toBe('common.unknown');
    expect(describeTransferError(undefined, t)).toBe('common.unknown');
  });
});

describe('describeBatchFailures', () => {
  const failure = (name: string, code: 'not_found' | 'timeout') => ({
    name,
    error: new FileApiError(500, code, code),
  });

  test('最多列 3 条「文件名: 原因」，超出以省略号收尾', () => {
    const text = describeBatchFailures(
      [
        failure('a', 'not_found'),
        failure('b', 'timeout'),
        failure('c', 'not_found'),
        failure('d', 'timeout'),
      ],
      t
    );
    expect(text).toBe(
      ['a: files.error.not_found', 'b: files.error.timeout', 'c: files.error.not_found', '…'].join(
        '\n'
      )
    );
  });

  test('不超过上限时没有省略号', () => {
    expect(describeBatchFailures([failure('a', 'timeout')], t)).toBe('a: files.error.timeout');
  });
});
