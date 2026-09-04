import { describe, expect, test } from 'bun:test';
import type { PooledUplink } from './types';
import type { UplinkCandidate } from './uplink-pool';
import {
  type UplinkSwitchHost,
  classifySwitchFailure,
  composeAbortSignals,
  runUplinkSwitch,
  terminalErrorOf,
} from './uplink-pool-switch';

function countingSignal(): {
  ac: AbortController;
  added: number;
  removed: number;
} {
  const ac = new AbortController();
  const state = { ac, added: 0, removed: 0 };
  const origAdd = ac.signal.addEventListener.bind(ac.signal);
  const origRemove = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
    if (args[0] === 'abort') state.added += 1;
    origAdd(...args);
  }) as AbortSignal['addEventListener'];
  ac.signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
    if (args[0] === 'abort') state.removed += 1;
    origRemove(...args);
  }) as AbortSignal['removeEventListener'];
  return state;
}

describe('composeAbortSignals', () => {
  test('finally cleanup 会卸掉两个父信号上的监听器', () => {
    const a = countingSignal();
    const b = countingSignal();
    const combined = composeAbortSignals(a.ac.signal, b.ac.signal);
    expect(a.added).toBe(1);
    expect(b.added).toBe(1);
    combined.cleanup();
    expect(a.removed).toBe(1);
    expect(b.removed).toBe(1);
    expect(combined.signal.aborted).toBe(false);
  });

  test('任一父信号中止时也会卸掉另一侧监听器', () => {
    const a = countingSignal();
    const b = countingSignal();
    const combined = composeAbortSignals(a.ac.signal, b.ac.signal);
    a.ac.abort();
    expect(combined.signal.aborted).toBe(true);
    expect(a.removed).toBe(1);
    expect(b.removed).toBe(1);
    combined.cleanup();
    expect(a.removed).toBe(1);
    expect(b.removed).toBe(1);
  });

  test('N 次成功组合后父信号无残留监听', () => {
    const parent = countingSignal();
    for (let i = 0; i < 8; i += 1) {
      const child = countingSignal();
      const combined = composeAbortSignals(parent.ac.signal, child.ac.signal);
      expect(combined.signal.aborted).toBe(false);
      combined.cleanup();
    }
    expect(parent.added).toBe(parent.removed);
    expect(parent.added).toBe(8);
  });
});

describe('classifySwitchFailure', () => {
  test('先按调用中止 / 池停止 / token 过期归一化', () => {
    const timedOut = new AbortController();
    timedOut.abort();
    const host = {
      stopSignal: () => new AbortController().signal,
      isSwitchCurrent: () => false,
    };
    expect(classifySwitchFailure(host, 1, timedOut.signal, new Error('connect-failed'))).toBe(
      'connect-timeout'
    );
    const stopped = new AbortController();
    stopped.abort();
    expect(
      classifySwitchFailure(
        { stopSignal: () => stopped.signal, isSwitchCurrent: () => true },
        1,
        undefined,
        new Error('connect-failed')
      )
    ).toBe('aborted');
    expect(classifySwitchFailure(host, 1, undefined, new Error('connect-failed'))).toBe(
      'superseded'
    );
    expect(
      classifySwitchFailure(
        { stopSignal: () => new AbortController().signal, isSwitchCurrent: () => true },
        1,
        undefined,
        new Error('connect-failed')
      )
    ).toBe('connect-failed');
  });
});

describe('terminalErrorOf', () => {
  test('忽略 stopped/aborted', () => {
    const stopped = { lastConnectError: { reason: 'stopped', at: 1 } } as PooledUplink;
    const lost = { lastConnectError: { reason: 'missed-pong', at: 1 } } as PooledUplink;
    expect(terminalErrorOf(stopped)).toBeNull();
    expect(terminalErrorOf(lost)).toBe('missed-pong');
  });
});

function cand(url: string): UplinkCandidate {
  return {
    hubNodeId: null,
    publicUrl: url,
    mode: 'standby',
    writerEpoch: 1,
    priority: 10,
    caFingerprint: null,
  };
}

function fakeClient(url: string, state: PooledUplink['state'] = 'offline'): PooledUplink {
  return {
    hubUrl: url,
    state,
    identity: { nodeId: 'aa'.repeat(16), edSecretKey: new Uint8Array(32) },
    userId: 'user-1',
    lastKeyLogHead: null,
    link: null,
    lastConnectError: null,
    onStateChange: () => () => {},
    setOnRelayStream: () => {},
    attemptConnect: async () => {},
    connectWithLink: async () => {},
    waitUntilClosed: async () => {},
    stop: async () => {},
    sendCtl: () => {},
    sendStatus: () => {},
    sendStatusIfChanged: () => false,
    openRelay: async () => {
      throw new Error('no relay');
    },
    queryHubHead: async () => null,
    queryKeyLogAt: async () => null,
    appendAndAck: async () => ({ ok: false }),
    requestCatchUpNow: () => {},
  } as PooledUplink;
}

describe('runUplinkSwitch 连接失败归一化', () => {
  test('新切换开始后旧连接抛 connect-failed 记 superseded 且不写诊断', async () => {
    const stop = new AbortController();
    let token = 0;
    let live: PooledUplink | null = fakeClient('https://b.example', 'online');
    const failures: string[] = [];
    let connect: (client: PooledUplink) => Promise<void> = async () => {};
    const host: UplinkSwitchHost = {
      candidates: () => [cand('https://a.example'), cand('https://b.example')],
      attachedHub: () => ({
        hubNodeId: null,
        publicUrl: 'https://b.example',
        mode: 'standby',
        writerEpoch: 1,
        since: 1,
      }),
      liveClient: () => live,
      stopSignal: () => stop.signal,
      pending: null,
      noteAttempt: () => {},
      logCandidateEvent: () => {},
      lastErrorOf: () => null,
      isLocalTransport: () => false,
      beginSwitch: () => {
        token += 1;
        return token;
      },
      isSwitchCurrent: (value) => value === token,
      spawn: (row) => fakeClient(row.publicUrl),
      connectCandidate: async (client) => connect(client),
      promote: async (client) => {
        live = client;
        live.state = 'online';
        host.pending = null;
      },
      noteFailure: (_cand, msg) => {
        failures.push(msg);
      },
      logCandidateFailed: () => {},
      logMissingCaPin: () => {},
    };
    let release = () => {};
    let started = false;
    const gate = new Promise<void>((_resolve, reject) => {
      release = () => reject(new Error('connect-failed'));
    });
    connect = async () => {
      started = true;
      await gate;
    };
    const first = runUplinkSwitch(host, 'https://a.example');
    for (let i = 0; i < 20 && !started; i += 1) await Promise.resolve();
    expect(started).toBe(true);
    token += 1;
    release();
    expect(await first).toEqual({ ok: false, reason: 'superseded' });
    expect(failures).toEqual([]);
  });
});
