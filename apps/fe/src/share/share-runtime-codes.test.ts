import { describe, expect, test } from 'bun:test';
import {
  SHARE_WS_ENDED_CODE,
  SHARE_WS_LOGIN_REQUIRED_CODE,
  SHARE_WS_QUERY_PARAM,
  isShareTerminalCloseCode,
  withShareWsParam,
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

describe('withShareWsParam', () => {
  test('接在已有查询串后面（createNodeWsUrlSource 已拼了 ?cid=）', () => {
    expect(withShareWsParam('wss://h/ws?cid=abc', 'sh1')).toBe('wss://h/ws?cid=abc&share=sh1');
  });

  test('没有查询串时自己起头', () => {
    expect(withShareWsParam('wss://h/n/n1/ws', 'sh1')).toBe('wss://h/n/n1/ws?share=sh1');
  });

  test('shareId 进查询串前转义', () => {
    expect(withShareWsParam('wss://h/ws', 'a/b c')).toBe('wss://h/ws?share=a%2Fb%20c');
  });

  test('参数名与后端契约一致', () => {
    expect(SHARE_WS_QUERY_PARAM).toBe('share');
  });
});
