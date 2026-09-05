// 直连失败码：ws 拨号分类 / DataChannel 失败原文 → 前端可翻译的稳定码。
// 码一旦变了前端就会掉回原文，所以这里逐个钉死。

import { describe, expect, test } from 'bun:test';
import { dcFailureCode, dcFailureReason, wsFailureCode } from './direct-failure-codes';
import type { DirectFailureCode } from './peer-manager-types';
import type { WsSecureCandidate } from './peer-ws-race';
import { classifyWsDialFailure, raceWsSecureEndpoints } from './peer-ws-race';
import { PeerHandshakeError } from './types';

const URL = 'ws://127.0.0.1:39001/peer';

describe('wsFailureCode', () => {
  test('每种拨号分类都有码，超时的两种合并成 timeout', () => {
    expect(wsFailureCode('timeout')).toBe('timeout');
    expect(wsFailureCode('open-timeout')).toBe('timeout');
    expect(wsFailureCode('refused')).toBe('refused');
    expect(wsFailureCode('unreachable')).toBe('unreachable');
    expect(wsFailureCode('reset')).toBe('reset');
    expect(wsFailureCode('protocol')).toBe('handshake');
    expect(wsFailureCode('tls')).toBe('tls');
    expect(wsFailureCode('revoked')).toBe('revoked');
    expect(wsFailureCode('untrusted')).toBe('untrusted');
    expect(wsFailureCode('aborted')).toBe('aborted');
    expect(wsFailureCode('other')).toBe('other');
  });

  test('没有分类（旧竞速结果）落到 other', () => {
    expect(wsFailureCode(null)).toBe('other');
    expect(wsFailureCode(undefined)).toBe('other');
  });
});

describe('classifyWsDialKind 的窄化', () => {
  test('失效的对端凭据与证书错误从 protocol 里分出来', () => {
    expect(classifyWsDialFailure(URL, new PeerHandshakeError('revoked', 'node revoked')).kind).toBe(
      'revoked'
    );
    expect(classifyWsDialFailure(URL, new Error('self-signed certificate')).kind).toBe('tls');
    expect(
      classifyWsDialFailure(URL, new Error('unable to verify the first certificate')).kind
    ).toBe('tls');
    expect(classifyWsDialFailure(URL, new Error('peer not-trusted')).kind).toBe('untrusted');
    expect(classifyWsDialFailure(URL, new PeerHandshakeError('bad_signature', 'sig')).kind).toBe(
      'protocol'
    );
  });

  test('窄化后的分类照样进得了失败码', () => {
    const kinds = ['revoked', 'tls', 'untrusted'] as const;
    for (const kind of kinds) expect(wsFailureCode(kind)).toBe(kind);
  });
});

describe('raceWsSecureEndpoints', () => {
  test('把最后一次失败的分类与地址一并带出来', async () => {
    const result = await raceWsSecureEndpoints({
      urls: ['ws://127.0.0.1:1/peer'],
      gen: 1,
      signal: new AbortController().signal,
      stale: () => false,
      sleep: async () => undefined,
      staggerMs: 0,
      dial: async (url): Promise<WsSecureCandidate | null> => {
        throw classifyWsDialFailure(url, new Error('ECONNREFUSED'));
      },
    });
    expect(result.winner).toBeNull();
    expect(result.lastKind).toBe('refused');
    expect(result.lastUrl).toBe('ws://127.0.0.1:1/peer');
    expect(wsFailureCode(result.lastKind)).toBe('refused');
  });

  test('父 signal 已 abort 时直接返回，不带分类', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await raceWsSecureEndpoints({
      urls: ['ws://127.0.0.1:1/peer'],
      gen: 1,
      signal: ac.signal,
      stale: () => false,
      sleep: async () => undefined,
      staggerMs: 0,
      dial: async () => null,
    });
    expect(result.lastKind).toBeNull();
    expect(result.lastUrl).toBeNull();
  });
});

describe('dcFailureCode', () => {
  const cases: Array<[string, DirectFailureCode]> = [
    ['signal dropped before answer', 'signal_dropped'],
    ['liveness probe failed', 'liveness_timeout'],
    ['missed-pong', 'liveness_timeout'],
    ['datachannel open timeout', 'dc_open_timeout'],
    ['ice failed', 'ice_failed'],
    ['aborted by caller', 'aborted'],
    ['fingerprint mismatch', 'handshake'],
    ['channel-error', 'dc_closed'],
    ['datachannel closed', 'dc_closed'],
    ['transport lost', 'dc_closed'],
    ['unexpected remote offer in signaling state stable', 'signaling_state'],
    ['no ice candidates gathered', 'no_candidates'],
    ['something nobody classified', 'other'],
  ];
  for (const [reason, code] of cases) {
    test(`「${reason}」→ ${code}`, () => {
      expect(dcFailureCode(reason)).toBe(code);
    });
  }
});

describe('dcFailureReason', () => {
  const base = { directCapable: true, rtcAvailable: true };

  test('对端不支持直连 / 本机没有 WebRTC 各自成码', () => {
    expect(dcFailureReason('peer', null, { ...base, directCapable: false })).toEqual({
      text: 'direct_capable=false',
      code: 'not_direct_capable',
    });
    expect(dcFailureReason('peer', null, { ...base, rtcAvailable: false })).toEqual({
      text: 'datachannel unavailable',
      code: 'rtc_unavailable',
    });
  });

  test('熔断冷却时也记一行，并带上解除时刻', () => {
    expect(dcFailureReason('peer', null, { ...base, coolingUntil: 1_700_000_000_000 })).toEqual({
      text: 'dial breaker cooling',
      code: 'breaker_cooling',
      params: { until: 1_700_000_000_000 },
    });
    expect(dcFailureReason('peer', null, { ...base, coolingUntil: null })).toEqual({
      text: 'dial breaker cooling',
      code: 'breaker_cooling',
      params: undefined,
    });
  });

  test('拨号真跑过就按错误原文分类；没跑过也没冷却则不记', () => {
    expect(dcFailureReason('peer', new Error('datachannel open timeout'), base)).toEqual({
      text: 'datachannel open timeout',
      code: 'dc_open_timeout',
    });
    expect(dcFailureReason('peer', null, base)).toBeNull();
  });
});
