import { describe, expect, test } from 'bun:test';
import {
  SHARE_WS_ENDED_CODE,
  SHARE_WS_LOGIN_REQUIRED_CODE,
  isShareTerminalCloseCode,
} from './share-runtime';

describe('isShareTerminalCloseCode', () => {
  test('4410 / 4401 是终态：重连只会被原样再关一次', () => {
    expect(isShareTerminalCloseCode(SHARE_WS_ENDED_CODE)).toBe(true);
    expect(isShareTerminalCloseCode(SHARE_WS_LOGIN_REQUIRED_CODE)).toBe(true);
  });

  test('普通断开仍走重连', () => {
    expect(isShareTerminalCloseCode(1006)).toBe(false);
    expect(isShareTerminalCloseCode(1000)).toBe(false);
    expect(isShareTerminalCloseCode(4409)).toBe(false);
  });
});
