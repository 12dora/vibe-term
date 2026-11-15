import { describe, expect, test } from 'bun:test';
import {
  POP_ERROR_MESSAGE_ZH,
  popAuthError,
  popCodeFromMessage,
  popErrorMessage,
} from './session-pop';

describe('PoP error copy', () => {
  test('zh-cn message ends with a Chinese full stop', () => {
    expect(POP_ERROR_MESSAGE_ZH).toBe('会话密钥缺失或无效，请重新执行 vibeterm login。');
    expect(POP_ERROR_MESSAGE_ZH.endsWith('。')).toBe(true);
    expect(POP_ERROR_MESSAGE_ZH.endsWith('.')).toBe(false);
  });
});

describe('popCodeFromMessage', () => {
  test('accepts a bare WS close reason and HTTP 401 JSON', () => {
    expect(popCodeFromMessage('POP_REQUIRED')).toBe('POP_REQUIRED');
    expect(popCodeFromMessage('POP_INVALID')).toBe('POP_INVALID');
    expect(popCodeFromMessage(JSON.stringify({ code: 'POP_REQUIRED' }))).toBe('POP_REQUIRED');
    expect(popCodeFromMessage(JSON.stringify({ code: 'POP_INVALID' }))).toBe('POP_INVALID');
    expect(popCodeFromMessage('session invalid')).toBeNull();
    expect(popCodeFromMessage(JSON.stringify({ code: 'expired' }))).toBeNull();
  });

  test('popAuthError is not a logged-out message', () => {
    const prev = process.env.VIBETERM_CLI_LANG;
    process.env.VIBETERM_CLI_LANG = 'zh-CN';
    try {
      expect(popErrorMessage()).toBe(POP_ERROR_MESSAGE_ZH);
      const error = popAuthError('POP_INVALID');
      expect(error.code).toBe('POP_INVALID');
      expect(error.message).toBe(POP_ERROR_MESSAGE_ZH);
      expect(error.hint).toBe('run: vibeterm login');
    } finally {
      if (prev === undefined) delete process.env.VIBETERM_CLI_LANG;
      else process.env.VIBETERM_CLI_LANG = prev;
    }
  });
});
