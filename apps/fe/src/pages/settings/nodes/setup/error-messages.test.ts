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

describe('describeSetupError 的中继口径', () => {
  test('加入中继失败不再说 Hub', () => {
    expect(
      describeSetupError(t, new SetupApiError('join_failed', 'join_failed', 400), 'relay')
    ).toBe('nodes.setup.errors.relay.join_failed');
    for (const code of ['hub_unreachable', 'node_revoked', 'node_exists']) {
      expect(describeSetupError(t, new SetupApiError(code, code, 400), 'relay')).toBe(
        `nodes.setup.errors.relay.${code}`
      );
    }
  });

  test('没有中继专用文案的码回落到通用键', () => {
    expect(
      describeSetupError(t, new SetupApiError('invalid_url', 'invalid_url', 400), 'relay')
    ).toBe('nodes.setup.errors.invalid_url');
  });

  test('两个 409 有自己的文案，不再退化成英文原文', () => {
    for (const code of ['setup_committed', 'setup_in_progress']) {
      expect(describeSetupError(t, new SetupApiError(code, code, 409))).toBe(
        `nodes.setup.errors.${code}`
      );
    }
  });
});

describe('relay-join 的稳定错误码', () => {
  test('六个新码都有本地化文案，不再退化成「未知错误」', () => {
    for (const code of [
      'relay_password_invalid',
      'relay_tenant_unknown',
      'relay_pack_invalid',
      'relay_not_authorized',
      'local_user_exists',
    ]) {
      expect(describeSetupError(t, new SetupApiError(code, code, 400), 'relay')).toBe(
        `nodes.setup.errors.${code}`
      );
    }
  });

  test('relay_unreachable 附上后端给的网络原因', () => {
    expect(
      describeSetupError(t, new SetupApiError('relay_unreachable', 'ECONNREFUSED', 502), 'relay')
    ).toBe(
      'nodes.setup.errors.withDetail|{"base":"nodes.setup.errors.relay_unreachable","detail":"ECONNREFUSED"}'
    );
  });
});
