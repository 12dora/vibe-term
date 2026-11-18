import { describe, expect, test } from 'bun:test';
import { generateEd25519KeyPair } from '@vibeterm/shared/auth';
import {
  POP_ERROR_MESSAGE_ZH,
  copyPopKey,
  isNodeLoginRequiredJobError,
  isPopAuthJobError,
  popAuthError,
  popCodeFromMessage,
  popErrorMessage,
  popNodeErrorMessage,
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

  test('popNodeErrorMessage names the node and reuses the PoP copy', () => {
    expect(popNodeErrorMessage('office')).toBe(`office: ${popErrorMessage()}`);
    expect(popNodeErrorMessage('office')).toContain('vibeterm login');
  });

  test('isPopAuthJobError matches POP codes and auth: job errors', () => {
    expect(isPopAuthJobError('POP_REQUIRED')).toBe(true);
    expect(isPopAuthJobError('POP_INVALID')).toBe(true);
    expect(isPopAuthJobError('auth: POP_REQUIRED')).toBe(true);
    expect(isPopAuthJobError('auth: expired')).toBe(true);
    expect(isPopAuthJobError('auth: NODE_LOGIN_REQUIRED')).toBe(false);
    expect(isPopAuthJobError('NODE_LOGIN_REQUIRED')).toBe(false);
    expect(isPopAuthJobError('UPGRADE_FAILED')).toBe(false);
    expect(isNodeLoginRequiredJobError('NODE_LOGIN_REQUIRED')).toBe(true);
    expect(isNodeLoginRequiredJobError('auth: NODE_LOGIN_REQUIRED')).toBe(true);
    expect(isNodeLoginRequiredJobError('auth: POP_REQUIRED')).toBe(false);
  });

  test('copyPopKey does not share buffers with the source', () => {
    const pair = generateEd25519KeyPair();
    const original = { sessSk: pair.secretKey, sessPk: pair.publicKey };
    const copy = copyPopKey(original);
    expect(copy.sessSk).toEqual(original.sessSk);
    expect(copy.sessPk).toEqual(original.sessPk);
    expect(copy.sessSk).not.toBe(original.sessSk);
    expect(copy.sessPk).not.toBe(original.sessPk);
    copy.sessSk.fill(0);
    copy.sessPk.fill(0);
    expect(original.sessSk.some((byte) => byte !== 0)).toBe(true);
    expect(original.sessPk.some((byte) => byte !== 0)).toBe(true);
  });
});
