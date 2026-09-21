// 「这台 node 该显示成什么」的唯一判定。侧边栏、设备页分组、节点管理表共用这一份。

import { describe, expect, test } from 'bun:test';
import { nodeSignInState } from './node-signin-state';

describe('nodeSignInState', () => {
  test('离线压倒一切：节点不在线时不谈登录，也不谈连接', () => {
    expect(nodeSignInState({ online: false, loggedIn: true })).toBe('offline');
    expect(nodeSignInState({ online: false, loggedIn: false, unreachable: true })).toBe('offline');
    expect(nodeSignInState({ online: false, loggedIn: false, failureCode: 'NO_SESSION_KEY' })).toBe(
      'offline'
    );
  });

  test('没有任何故障证据时按 loggedIn 走老口径', () => {
    expect(nodeSignInState({ online: true, loggedIn: true })).toBe('ready');
    expect(nodeSignInState({ online: true, loggedIn: false })).toBe('signedOut');
  });

  test('传输层失败 → 连接不上，不说「未登录」', () => {
    expect(
      nodeSignInState({ online: true, loggedIn: false, failureCode: 'NODE_UNREACHABLE' })
    ).toBe('unreachable');
    expect(nodeSignInState({ online: true, loggedIn: false, failureCode: 'NETWORK_ERROR' })).toBe(
      'unreachable'
    );
  });

  test('REST 正在退避同样算「连接不上」：那是实打实问不到', () => {
    expect(nodeSignInState({ online: true, loggedIn: false, unreachable: true })).toBe(
      'unreachable'
    );
  });

  test('打不通排在 loggedIn 之前：cookie 在不在跟链路通不通是两件事', () => {
    expect(nodeSignInState({ online: true, loggedIn: true, unreachable: true })).toBe(
      'unreachable'
    );
    expect(nodeSignInState({ online: true, loggedIn: true, failureCode: 'NODE_UNREACHABLE' })).toBe(
      'unreachable'
    );
  });

  test('凭证类失败仍是「未登录」：用户登一次就能进去', () => {
    expect(
      nodeSignInState({ online: true, loggedIn: false, failureCode: 'PASSKEY_REQUIRED' })
    ).toBe('signedOut');
    expect(nodeSignInState({ online: true, loggedIn: false, failureCode: 'RATE_LIMITED' })).toBe(
      'signedOut'
    );
  });
});
