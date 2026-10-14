import { describe, expect, test } from 'bun:test';
import type { NodeSessionStore } from '../auth/node-session-store';
import { FakeLinkStream } from '../exec/channel/test-link-stream';
import { encodeJsonBytes } from './ctl';
import { acceptExecStream } from './exec-stream-target';
import { type PeerInboundStreamHost, handlePeerInboundStream } from './peer-live-inbound';
import { classifyOpenPayload } from './stream-targets';

const verifyOk = { ok: true, session: { userId: 'user-1' } };

function sessionStore(result: unknown, seen: unknown[] = []): NodeSessionStore {
  return {
    verify: (sid: string, input: unknown) => {
      seen.push([sid, input]);
      return result;
    },
  } as unknown as NodeSessionStore;
}

describe('classifyOpenPayload exec', () => {
  test('{type:exec} is exec', () => {
    expect(classifyOpenPayload(encodeJsonBytes({ type: 'exec', credential: 'sid' }))).toBe('exec');
  });

  test('exec wins over the legacy ws heuristics', () => {
    expect(classifyOpenPayload(encodeJsonBytes({ type: 'exec', auth: 'sid' }))).toBe('exec');
  });

  test('legacy {auth} payload without a type is still ws', () => {
    expect(classifyOpenPayload(encodeJsonBytes({ auth: 'sid' }))).toBe('ws');
    expect(classifyOpenPayload(encodeJsonBytes({ type: 'ws', auth: 'sid' }))).toBe('ws');
  });

  test('other kinds are unchanged', () => {
    expect(classifyOpenPayload(encodeJsonBytes({ type: 'tcp', mapId: 'm' }))).toBe('tcp');
    expect(classifyOpenPayload(encodeJsonBytes({ type: 'http', method: 'GET', path: '/' }))).toBe(
      'http'
    );
    expect(classifyOpenPayload(encodeJsonBytes({ to: 'node' }))).toBe('relay');
    expect(classifyOpenPayload(encodeJsonBytes({ type: 'nope' }))).toBe('unknown');
  });
});

describe('acceptExecStream', () => {
  test('a valid session attaches the exec channel with the verified principal', () => {
    const seen: unknown[] = [];
    const stream = new FakeLinkStream(encodeJsonBytes({ type: 'exec', credential: 'sid-1' }));
    const attached: unknown[] = [];
    acceptExecStream(
      stream,
      { peerNodeId: 'entry-a', sessionStore: sessionStore(verifyOk, seen), now: () => 5 },
      (s, auth) => attached.push([s, auth])
    );
    expect(attached).toEqual([[stream, { uid: 'user-1', tokenId: null }]]);
    expect(seen).toEqual([['sid-1', { viaNodeId: 'entry-a', now: 5 }]]);
    expect(stream.dead).toBe(false);
  });

  test('a rejected credential resets with auth:<reason>', () => {
    const stream = new FakeLinkStream(encodeJsonBytes({ type: 'exec', credential: 'sid-1' }));
    const attached: unknown[] = [];
    acceptExecStream(
      stream,
      { peerNodeId: 'entry-a', sessionStore: sessionStore({ ok: false, reason: 'expired' }) },
      () => attached.push(1)
    );
    expect(stream.resetReason).toBe('auth:expired');
    expect(attached).toHaveLength(0);
  });

  test('tok: credentials reset with auth:unsupported until token auth lands', () => {
    const stream = new FakeLinkStream(encodeJsonBytes({ type: 'exec', credential: 'tok:vtk_x' }));
    const ctx = { peerNodeId: 'entry-a', sessionStore: sessionStore(verifyOk) };
    acceptExecStream(stream, ctx, () => {});
    expect(stream.resetReason).toBe('auth:unsupported');
  });

  test('a missing credential resets with auth:missing auth', () => {
    const stream = new FakeLinkStream(encodeJsonBytes({ type: 'exec' }));
    const ctx = { peerNodeId: 'entry-a', sessionStore: sessionStore(verifyOk) };
    acceptExecStream(stream, ctx, () => {});
    expect(stream.resetReason).toBe('auth:missing auth');
  });

  test('a throwing session store resets instead of throwing', () => {
    const stream = new FakeLinkStream(encodeJsonBytes({ type: 'exec', credential: 'sid-1' }));
    const store = {
      verify: () => {
        throw new Error('db down');
      },
    } as unknown as NodeSessionStore;
    acceptExecStream(stream, { peerNodeId: 'entry-a', sessionStore: store }, () => {});
    expect(stream.resetReason).toBe('auth:error');
  });
});

describe('handlePeerInboundStream exec', () => {
  function host(store?: NodeSessionStore): PeerInboundStreamHost {
    return {
      selfNodeId: 'self',
      dispatchHttp: () => undefined,
      sessionStore: store,
      now: () => 1,
      onGatewaySession: null,
      onGatewaySessionClose: null,
    };
  }

  test('without a session store the stream is reset as not configured', () => {
    const stream = new FakeLinkStream(encodeJsonBytes({ type: 'exec', credential: 'sid-1' }));
    handlePeerInboundStream(host(), 'entry-a', stream);
    expect(stream.resetReason).toBe('exec-not-configured');
  });

  test('an exec stream with a bad credential is reset with the auth reason', () => {
    const stream = new FakeLinkStream(encodeJsonBytes({ type: 'exec', credential: 'sid-1' }));
    const store = sessionStore({ ok: false, reason: 'revoked' });
    handlePeerInboundStream(host(store), 'entry-a', stream);
    expect(stream.resetReason).toBe('auth:revoked');
  });
});
