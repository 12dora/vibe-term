// 带原因的错误码必须把后端 message 一起显示出来，否则 `ca_fingerprint_mismatch`
// 这类唯一有用的诊断信息会被本地化文案吞掉。

import { describe, expect, test } from 'bun:test';
import { SetupApiError } from '@tmex/api-client/local/setup-api';
import { describeSetupError } from './error-messages';

const t = (key: string, options?: Record<string, unknown>): string =>
  options ? `${key}|${JSON.stringify(options)}` : key;

describe('describeSetupError', () => {
  test('join_failed 附上后端给的原因', () => {
    const message = describeSetupError(
      t,
      new SetupApiError('join_failed', 'ca_fingerprint_mismatch', 400)
    );
    expect(message).toBe(
      'nodes.setup.errors.withDetail|{"base":"nodes.setup.errors.join_failed","detail":"ca_fingerprint_mismatch"}'
    );
  });

  test('hub_unreachable / env_write_failed / direct_* 同样附原因', () => {
    for (const code of [
      'hub_unreachable',
      'env_write_failed',
      'direct_unsupported',
      'direct_download_failed',
      'direct_failed',
    ]) {
      expect(describeSetupError(t, new SetupApiError(code, 'boom', 500))).toBe(
        `nodes.setup.errors.withDetail|{"base":"nodes.setup.errors.${code}","detail":"boom"}`
      );
    }
  });

  test('message 就是错误码本身时不重复拼接', () => {
    expect(describeSetupError(t, new SetupApiError('join_failed', 'join_failed', 400))).toBe(
      'nodes.setup.errors.join_failed'
    );
    expect(describeSetupError(t, new SetupApiError('join_failed', '   ', 400))).toBe(
      'nodes.setup.errors.join_failed'
    );
  });

  test('message 不带信息的错误码保持静态文案', () => {
    expect(
      describeSetupError(t, new SetupApiError('weak_password', 'password too short', 400))
    ).toBe('nodes.setup.errors.weak_password');
    expect(describeSetupError(t, new SetupApiError('user_exists', 'alice exists', 409))).toBe(
      'nodes.setup.errors.user_exists'
    );
  });

  test('未知错误码与普通异常都走 unknown', () => {
    expect(describeSetupError(t, new SetupApiError('kaboom', 'went wrong', 500))).toBe(
      'nodes.setup.errors.unknown|{"message":"went wrong"}'
    );
    expect(describeSetupError(t, new Error('offline'))).toBe(
      'nodes.setup.errors.unknown|{"message":"offline"}'
    );
  });
});
