// 退出失败的文案映射：已知错误码走专用文案，未知的退化成通用文案 + 原始信息。

import { describe, expect, test } from 'bun:test';
import { LocalApiError } from '@tmex/api-client/local/local-api';
import { describeLeaveError } from './use-leave-mesh';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${JSON.stringify(options)})` : key;

describe('describeLeaveError', () => {
  test('契约里的错误码各有专用文案，不再追加原始信息', () => {
    expect(describeLeaveError(t, new LocalApiError('role_mismatch', 'role_mismatch', 409))).toBe(
      'nodes.membership.errors.roleMismatch'
    );
    expect(describeLeaveError(t, new LocalApiError('not_member', '不是成员', 400))).toBe(
      'nodes.membership.errors.notMember'
    );
    expect(describeLeaveError(t, new LocalApiError('setup_in_progress', 'busy', 409))).toBe(
      'nodes.membership.errors.setupInProgress'
    );
    expect(describeLeaveError(t, new LocalApiError('env_write_failed', 'EACCES', 500))).toBe(
      'nodes.membership.errors.envWriteFailed'
    );
    expect(describeLeaveError(t, new LocalApiError('unauthorized', 'login required', 401))).toBe(
      'nodes.membership.errors.unauthorized'
    );
  });

  test('未知错误退化到通用文案 + 原始信息', () => {
    expect(describeLeaveError(t, new Error('boom'))).toBe(
      'nodes.membership.errorDetail({"base":"nodes.membership.leaveFailed","detail":"boom"})'
    );
  });

  test('message 就是错误码时不重复展示', () => {
    expect(describeLeaveError(t, new LocalApiError('leave_failed', 'leave_failed', 502))).toBe(
      'nodes.membership.leaveFailed'
    );
  });
});
