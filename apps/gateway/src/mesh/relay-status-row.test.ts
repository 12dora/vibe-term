import { afterEach, describe, expect, test } from 'bun:test';
import { ingestTurnOk, resetPortReachForTest } from './port-reach';
import { buildRelayStatusRow, enrichRelayTurnView, relayLinkError } from './relay-status-row';
import { ensureTcpSamplingTrust, resetTcpSamplingTrustForTest } from './tcp-sampling-trust';

describe('relayLinkError', () => {
  test('attached row uses the live client error, not the pool candidate', () => {
    expect(
      relayLinkError({
        attached: true,
        clientError: { reason: 'bad-token', at: 9 },
        candidate: { lastError: 'stale-pool', lastErrorAt: 1 },
      })
    ).toEqual({ lastError: 'bad-token', lastErrorAt: 9 });
    expect(
      relayLinkError({
        attached: true,
        clientError: null,
        candidate: { lastError: 'stale-pool', lastErrorAt: 1 },
      })
    ).toEqual({ lastError: null, lastErrorAt: null });
  });

  test('unattached row uses the pool candidate failure', () => {
    expect(
      relayLinkError({
        attached: false,
        clientError: { reason: 'other', at: 3 },
        candidate: { lastError: 'member-epoch_mismatch', lastErrorAt: 42 },
      })
    ).toEqual({ lastError: 'member-epoch_mismatch', lastErrorAt: 42 });
    expect(relayLinkError({ attached: false, clientError: null, candidate: null })).toEqual({
      lastError: null,
      lastErrorAt: null,
    });
  });
});

describe('buildRelayStatusRow', () => {
  test('fills lastError from the matching unattached candidate', () => {
    const row = buildRelayStatusRow(
      { url: 'https://b.example', priority: 1, kicked: false },
      'https://a.example',
      null,
      null,
      [{ publicUrl: 'https://b.example', lastError: 'client-too-old', lastErrorAt: 7 }]
    );
    expect(row).toMatchObject({
      url: 'https://b.example',
      attached: false,
      online: false,
      role: null,
      lastError: 'client-too-old',
      lastErrorCode: 'protocol',
      lastErrorAt: 7,
    });
  });

  test('secondary 在线行填 rtt / peersOnline / role，attached 仍为 false', () => {
    const row = buildRelayStatusRow(
      { url: 'https://b.example', priority: 1, kicked: false },
      'https://a.example',
      null,
      null,
      [],
      {
        connected: true,
        rttMs: 33,
        peersOnline: 4,
        turn: { url: 'turn:b:3478', probeOk: null },
      }
    );
    expect(row).toMatchObject({
      attached: false,
      online: true,
      role: 'secondary',
      rttMs: 33,
      peersOnline: 4,
      turn: { url: 'turn:b:3478', probeOk: null },
      lastError: null,
    });
  });

  test('secondary 分叉时带可选 keyLog.diverged', () => {
    const row = buildRelayStatusRow(
      { url: 'https://b.example', priority: 1, kicked: false },
      'https://a.example',
      null,
      null,
      [],
      {
        connected: true,
        rttMs: 20,
        peersOnline: 1,
        keyLog: { diverged: true },
      }
    );
    expect(row).toMatchObject({
      attached: false,
      online: true,
      role: 'secondary',
      keyLog: { diverged: true },
    });
  });

  test('online row 强制清空 lastError / lastErrorCode', () => {
    const row = buildRelayStatusRow(
      { url: 'https://a.example', priority: 0, kicked: false },
      'https://a.example',
      { state: 'online', rttMs: 12 },
      { lastConnectError: { reason: 'connect-failed', at: 9 } },
      [{ publicUrl: 'https://a.example', lastError: 'stale-pool', lastErrorAt: 1 }]
    );
    expect(row).toMatchObject({
      online: true,
      attached: true,
      role: 'primary',
      rttMs: 12,
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
    });
  });

  test('stopped / aborted 不当成当前错误', () => {
    const row = buildRelayStatusRow(
      { url: 'https://a.example', priority: 0, kicked: false },
      'https://a.example',
      { state: 'offline', rttMs: null },
      { lastConnectError: { reason: 'stopped', at: 3 } },
      []
    );
    expect(row).toMatchObject({
      online: false,
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
    });
  });

  test('path-rerace 不当成当前错误', () => {
    const row = buildRelayStatusRow(
      { url: 'https://a.example', priority: 0, kicked: false },
      'https://a.example',
      { state: 'offline', rttMs: null },
      { lastConnectError: { reason: 'path-rerace', at: 3 } },
      []
    );
    expect(row).toMatchObject({
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
    });
  });

  test('可选 pathBestMs / reraces 原样带出', () => {
    const row = buildRelayStatusRow(
      { url: 'https://a.example', priority: 0, kicked: false },
      'https://a.example',
      { state: 'online', rttMs: 90 },
      null,
      [],
      { connected: true, pathBestMs: 42, reraces: 1 }
    );
    expect(row).toMatchObject({ pathBestMs: 42, reraces: 1, rttMs: 90 });
  });
});

describe('enrichRelayTurnView', () => {
  afterEach(() => {
    resetPortReachForTest();
    resetTcpSamplingTrustForTest();
  });

  test('叠上该中继的成员 tally（不含自己）', () => {
    const relay = 'https://jp.example';
    const self = 'aa'.repeat(16);
    ingestTurnOk(self, false, relay);
    ingestTurnOk('cc'.repeat(16), true, relay);
    ingestTurnOk('dd'.repeat(16), true, relay);
    ingestTurnOk('ee'.repeat(16), false, 'https://sh.example');
    const view = enrichRelayTurnView({ url: 'turn:jp.example:40000', probeOk: false }, relay, {
      selfId: self,
    });
    expect(view).toMatchObject({
      url: 'turn:jp.example:40000',
      probeOk: false,
      members: { ok: 2, total: 2 },
    });
    expect(view?.localHint).toBeUndefined();
  });

  test('本机探测失败且 TCP 金丝雀不可信时带 localHint=tun', async () => {
    await ensureTcpSamplingTrust('203.0.113.10', Date.now(), async () => ({
      verdict: 'ok',
      connectMs: 1,
    }));
    const view = enrichRelayTurnView(
      { url: 'turn:jp.example:40000', probeOk: false },
      'https://jp.example'
    );
    expect(view?.localHint).toBe('tun');
    const ok = enrichRelayTurnView(
      { url: 'turn:jp.example:40000', probeOk: true },
      'https://jp.example'
    );
    expect(ok?.localHint).toBeUndefined();
  });
});
