import { describe, expect, test } from 'bun:test';
import { type LinkStream, createInMemoryLinkPair } from '@vibeterm/shared/link';
import {
  formatRelayChooseLog,
  isRetryableRelayOpenReason,
  openRelayStreamForPeer,
  relayOpenFailureReason,
  rstReasonOf,
} from './peer-dialer-relay';
import type { RelayChoice, RelayPresenceIndex, RelayStreamOpener } from './relay-presence-types';

function fakePresence(opts: {
  choice?: RelayChoice | null;
  primary?: string | null;
  relaysFor?: string[];
}): RelayPresenceIndex {
  return {
    snapshot: () => [],
    primaryUrl: () => opts.primary ?? null,
    relaysFor: () => opts.relaysFor ?? (opts.choice ? [opts.choice.url] : []),
    chooseRelay: () => ('choice' in opts ? (opts.choice ?? null) : null),
    onlineUnion: () => new Set(opts.relaysFor ?? []),
  };
}

async function rstStream(reason: string): Promise<LinkStream> {
  const [local, remote] = createInMemoryLinkPair();
  remote.onStream((stream) => stream.reset(reason));
  const out = await local.openStream(new Uint8Array([1]));
  await out.closed;
  return out;
}

describe('relay open reason helpers', () => {
  test('only offline / unknown-target are retryable', () => {
    expect(isRetryableRelayOpenReason('offline')).toBe(true);
    expect(isRetryableRelayOpenReason('unknown-target')).toBe(true);
    expect(isRetryableRelayOpenReason('quota-streams')).toBe(false);
    expect(isRetryableRelayOpenReason('handshake-failed')).toBe(false);
    expect(relayOpenFailureReason(new Error('offline'))).toBe('offline');
    expect(relayOpenFailureReason(new Error('uplink is not online'))).toBeNull();
  });

  test('rstReasonOf reads the RST payload from openStream', async () => {
    const stream = await rstStream('unknown-target');
    expect(await rstReasonOf(stream)).toBe('unknown-target');
  });
});

describe('openRelayStreamForPeer', () => {
  test('falls back to uplink.openRelay when presence or opener is missing', async () => {
    const [local] = createInMemoryLinkPair();
    const stream = await local.openStream(new Uint8Array([9]));
    let fallback = 0;
    const opened = await openRelayStreamForPeer({
      nodeId: 'aa'.repeat(16),
      openFallback: async () => {
        fallback += 1;
        return stream;
      },
    });
    expect(opened.stream).toBe(stream);
    expect(opened.viaRelay).toBeUndefined();
    expect(fallback).toBe(1);
  });

  test('falls back to uplink.openRelay when chooseRelay returns null', async () => {
    const [local] = createInMemoryLinkPair();
    const stream = await local.openStream(new Uint8Array([9]));
    const opened = await openRelayStreamForPeer({
      nodeId: 'aa'.repeat(16),
      presence: fakePresence({ choice: null, primary: 'https://sh.example' }),
      opener: { openRelayVia: async () => Promise.reject(new Error('should-not-open')) },
      openFallback: async () => stream,
    });
    expect(opened.stream).toBe(stream);
    expect(opened.viaRelay).toBeUndefined();
  });

  test('opens via chooseRelay and records viaRelay', async () => {
    const [local] = createInMemoryLinkPair();
    const stream = await local.openStream(new Uint8Array([1]));
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    let opened: Awaited<ReturnType<typeof openRelayStreamForPeer>>;
    try {
      opened = await openRelayStreamForPeer({
        nodeId: 'bb'.repeat(16),
        presence: fakePresence({
          choice: { url: 'https://ty.example', role: 'secondary', scoreMs: 80 },
          primary: 'https://sh.example',
          relaysFor: ['https://sh.example', 'https://ty.example'],
        }),
        opener: {
          openRelayVia: async (url) => {
            expect(url).toBe('https://ty.example');
            return stream;
          },
        },
        openFallback: async () => Promise.reject(new Error('no-fallback')),
      });
    } finally {
      console.log = orig;
    }
    expect(opened.stream).toBe(stream);
    expect(opened.viaRelay).toBe('https://ty.example');
    expect(
      logs.some(
        (line) =>
          line.includes('[mesh][peer] relay choose peer=') &&
          line.includes('via=https://ty.example') &&
          line.includes('score_ms=80') &&
          line.includes('candidates=2')
      )
    ).toBe(true);
  });

  test('retries once on the primary after offline / unknown-target', async () => {
    const [local] = createInMemoryLinkPair();
    const primaryStream = await local.openStream(new Uint8Array([2]));
    const urls: string[] = [];
    const opener: RelayStreamOpener = {
      async openRelayVia(url) {
        urls.push(url);
        if (url === 'https://ty.example') throw new Error('offline');
        return primaryStream;
      },
    };
    const opened = await openRelayStreamForPeer({
      nodeId: 'cc'.repeat(16),
      presence: fakePresence({
        choice: { url: 'https://ty.example', role: 'secondary', scoreMs: 40 },
        primary: 'https://sh.example',
        relaysFor: ['https://ty.example', 'https://sh.example'],
      }),
      opener,
      openFallback: async () => Promise.reject(new Error('no-fallback')),
    });
    expect(urls).toEqual(['https://ty.example', 'https://sh.example']);
    expect(opened.viaRelay).toBe('https://sh.example');
    expect(opened.stream).toBe(primaryStream);
  });

  test('retries once when openStream surfaces RST unknown-target', async () => {
    const [local] = createInMemoryLinkPair();
    const primaryStream = await local.openStream(new Uint8Array([3]));
    const urls: string[] = [];
    const opened = await openRelayStreamForPeer({
      nodeId: 'dd'.repeat(16),
      presence: fakePresence({
        choice: { url: 'https://ty.example', role: 'secondary', scoreMs: null },
        primary: 'https://sh.example',
        relaysFor: ['https://ty.example'],
      }),
      opener: {
        async openRelayVia(url) {
          urls.push(url);
          if (url === 'https://ty.example') return rstStream('unknown-target');
          return primaryStream;
        },
      },
      openFallback: async () => Promise.reject(new Error('no-fallback')),
    });
    expect(urls).toEqual(['https://ty.example', 'https://sh.example']);
    expect(opened.viaRelay).toBe('https://sh.example');
  });

  test('does not retry when the chosen relay is already primary', async () => {
    const urls: string[] = [];
    await expect(
      openRelayStreamForPeer({
        nodeId: 'ee'.repeat(16),
        presence: fakePresence({
          choice: { url: 'https://sh.example', role: 'primary', scoreMs: 20 },
          primary: 'https://sh.example',
        }),
        opener: {
          async openRelayVia(url) {
            urls.push(url);
            throw new Error('offline');
          },
        },
        openFallback: async () => Promise.reject(new Error('no-fallback')),
      })
    ).rejects.toThrow('offline');
    expect(urls).toEqual(['https://sh.example']);
  });

  test('does not retry quota or other RST reasons', async () => {
    const urls: string[] = [];
    await expect(
      openRelayStreamForPeer({
        nodeId: 'ff'.repeat(16),
        presence: fakePresence({
          choice: { url: 'https://ty.example', role: 'secondary', scoreMs: 10 },
          primary: 'https://sh.example',
        }),
        opener: {
          async openRelayVia(url) {
            urls.push(url);
            throw new Error('quota-streams');
          },
        },
        openFallback: async () => Promise.reject(new Error('no-fallback')),
      })
    ).rejects.toThrow('quota-streams');
    expect(urls).toEqual(['https://ty.example']);
  });

  test('logs relay choose with score and candidate count', () => {
    expect(formatRelayChooseLog('ab'.repeat(16), 'https://ty.example', 80, 2)).toBe(
      `relay choose peer=${'ab'.repeat(16)} via=https://ty.example score_ms=80 candidates=2`
    );
    expect(formatRelayChooseLog('ab'.repeat(16), 'https://sh.example', null, 1)).toContain(
      'score_ms=-'
    );
  });
});
