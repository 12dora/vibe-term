import { describe, expect, test } from 'bun:test';
import { type LinkSession, createInMemoryLinkPair } from '@vibeterm/shared/link';
import { Forwarder } from './forwarder';
import { setForwardLinkDeadlineMs } from './forwarder-deadline';
import { NodeUnreachableError } from './types';

const OTHER = 'bb'.repeat(16);
const NODE_ID = 'aa'.repeat(16);

describe('forward response budget', () => {
  test('slow getLink still leaves a response floor', async () => {
    setForwardLinkDeadlineMs(300);
    const [link] = createInMemoryLinkPair();
    try {
      const fwd = new Forwarder({
        nodeId: NODE_ID,
        peers: {
          getLink: async () => {
            await Bun.sleep(270);
            return link as LinkSession;
          },
          listReach: () => new Map(),
          onNodeEvent: () => () => {},
          transportOf: () => 'relay',
          rttOf: () => 20,
        },
        streams: {
          openHttpStream: (_link, _opts, _body, signal) =>
            new Promise<Response>((resolve, reject) => {
              const timer = setTimeout(
                () => resolve(new Response('{"ok":true}', { status: 200 })),
                80
              );
              signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(signal.reason);
              });
            }),
          openWsStream: async () => {
            throw new Error('unused');
          },
        },
        sleep: async () => {},
      });
      const res = (await fwd.handle(
        new Request(`http://localhost/n/${OTHER}/api/devices`, {
          headers: { cookie: `vibeterm_s_${OTHER}=sid` },
        }),
        { upgrade: () => true }
      )) as Response;
      expect(res.status).toBe(200);
    } finally {
      setForwardLinkDeadlineMs(0);
    }
  });

  test('later getLink failure stays no_link after an earlier link', async () => {
    let gets = 0;
    const fwd = new Forwarder({
      nodeId: NODE_ID,
      peers: {
        getLink: async () => {
          gets += 1;
          if (gets === 1) return {} as LinkSession;
          throw new NodeUnreachableError(OTHER, 'no session');
        },
        listReach: () => new Map(),
        onNodeEvent: () => () => {},
      },
      streams: {
        openHttpStream: async () => {
          throw new Error('post failed');
        },
        openWsStream: async () => {
          throw new Error('unused');
        },
      },
      sleep: async () => {},
    });
    const res = (await fwd.handle(
      new Request(`http://localhost/n/${OTHER}/api/devices`, {
        headers: { cookie: `vibeterm_s_${OTHER}=sid` },
      }),
      { upgrade: () => true }
    )) as Response;
    expect(res.status).toBe(503);
    expect(gets).toBeGreaterThan(1);
    expect(await res.json()).toMatchObject({ reason: 'no_link' });
  });
});
