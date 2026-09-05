import { describe, expect, test } from 'bun:test';
import { ApiError } from './client';
import { SHARE_ERROR_CODES, SHARE_GENERIC_ERROR_KEY, shareErrorKey } from './share-errors';

function apiError(code: string | null, status = 400): ApiError {
  return new ApiError(status, 'Terminal window not found on this device.', { code });
}

describe('shareErrorKey', () => {
  test('契约错误码映射到 share.error.<code>', () => {
    for (const code of SHARE_ERROR_CODES) {
      expect(shareErrorKey(apiError(code))).toBe(`share.error.${code}`);
    }
  });

  test('未知码、无码与非 ApiError 一律走通用兜底', () => {
    expect(shareErrorKey(apiError('SOMETHING_ELSE'))).toBe(SHARE_GENERIC_ERROR_KEY);
    expect(shareErrorKey(apiError(null))).toBe(SHARE_GENERIC_ERROR_KEY);
    expect(shareErrorKey(new Error('network down'))).toBe(SHARE_GENERIC_ERROR_KEY);
    expect(shareErrorKey(null)).toBe(SHARE_GENERIC_ERROR_KEY);
  });
});
