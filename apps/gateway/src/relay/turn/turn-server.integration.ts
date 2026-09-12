import { afterEach, describe, expect, test } from 'bun:test';
import dgram from 'node:dgram';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type TurnServer, createTurnServer } from './index';
import {
  ATTR,
  CLASS,
  METHOD,
  decodeAddress,
  decodeMessage,
  encodeMessage,
  getAttribute,
} from './stun-message';
import { closeSocket, listenUdp } from './turn-udp';

type NativePc = {
  close(): void;
  setRemoteDescription(sdp: string, type: string): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  createDataChannel(label: string): NativeDc;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onDataChannel(cb: (dc: NativeDc) => void): void;
  onIceStateChange?(cb: (state: string) => void): void;
  iceState?(): string;
  getSelectedCandidatePair?(): unknown;
};

type NativeDc = {
  sendMessage(msg: string): boolean;
  isOpen(): boolean;
  onOpen(cb: () => void): void;
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void;
  onError?(cb: (err: string) => void): void;
};

type NativeMod = {
  PeerConnection: new (
    peerName: string,
    config: {
      iceServers: Array<
        | string
        | {
            hostname: string;
            port: number;
            username?: string;
            password?: string;
            relayType?: 'TurnUdp' | 'TurnTcp' | 'TurnTls';
          }
      >;
      iceTransportPolicy?: 'all' | 'relay';
      bindAddress?: string;
    }
  ) => NativePc;
  cleanup(): void;
  preload(): void;
  initLogger(level: string, cb?: (level: string, message: string) => void): void;
};

const nativeDir = process.env.VIBETERM_NATIVE_DIR;
const addonPath = nativeDir ? join(nativeDir, 'node_datachannel.node') : null;

async function loadNativeFromEnv(): Promise<NativeMod | null> {
  if (!nativeDir || !addonPath) {
    console.warn('skipping turn-server.integration.ts: VIBETERM_NATIVE_DIR is unset');
    return null;
  }
  if (!existsSync(addonPath)) {
    console.warn(`skipping turn-server.integration.ts: addon missing at ${addonPath}`);
    return null;
  }
  process.env.VIBETERM_NATIVE_DIR = nativeDir;
  const require = createRequire(import.meta.url);
  try {
    const binding = require(addonPath) as NativeMod;
    if (!binding.PeerConnection) {
      console.warn('skipping turn-server.integration.ts: addon missing PeerConnection');
      return null;
    }
    return {
      PeerConnection: binding.PeerConnection,
      cleanup: binding.cleanup ?? (() => {}),
      preload: binding.preload ?? (() => {}),
      initLogger: binding.initLogger ?? (() => {}),
    };
  } catch (error) {
    console.warn(
      `skipping turn-server.integration.ts: failed to require addon: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

const nativeMod = await loadNativeFromEnv();

describe('TURN control socket Binding', () => {
  test('listener bound to 127.0.0.1 answers a Binding request', async () => {
    const server = createTurnServer({
      listenHost: '127.0.0.1',
      listenPort: 0,
      relayPortRange: { begin: 1, end: 1 },
      externalIp: '127.0.0.1',
      realm: 'vibeterm',
      credentials: () => null,
      deniedPeerCidrs: [],
    });
    const client = dgram.createSocket('udp4');
    try {
      const { port } = await server.start();
      await listenUdp(client, 0, '127.0.0.1');
      const reply = await new Promise<{ msg: Buffer; rinfo: dgram.RemoteInfo }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Binding timeout')), 1500);
          client.once('message', (msg, rinfo) => {
            clearTimeout(timer);
            resolve({ msg, rinfo });
          });
          client.send(
            encodeMessage({
              method: METHOD.BINDING,
              class: CLASS.REQUEST,
              fingerprint: true,
            }),
            port,
            '127.0.0.1'
          );
        }
      );
      expect(reply.rinfo.address).toBe('127.0.0.1');
      const decoded = decodeMessage(reply.msg);
      expect(decoded?.class).toBe(CLASS.SUCCESS);
      if (!decoded) throw new Error('missing STUN');
      const mapped = decodeAddress(
        getAttribute(decoded, ATTR.XOR_MAPPED_ADDRESS) ?? Buffer.alloc(0),
        decoded.transactionId
      );
      expect(mapped?.address).toBe('127.0.0.1');
      expect(server.snapshot().bindHost).toBe('127.0.0.1');
    } finally {
      await closeSocket(client);
      await server.stop();
    }
  });
});

function couple(left: NativePc, right: NativePc): void {
  left.onLocalDescription((sdp, type) => right.setRemoteDescription(sdp, type));
  right.onLocalDescription((sdp, type) => left.setRemoteDescription(sdp, type));
  left.onLocalCandidate((candidate, mid) => {
    if (candidate) right.addRemoteCandidate(candidate, mid);
  });
  right.onLocalCandidate((candidate, mid) => {
    if (candidate) left.addRemoteCandidate(candidate, mid);
  });
}

function waitOpen(dc: NativeDc, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TURN DataChannel open timeout')), timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    dc.onOpen(done);
    if (dc.isOpen()) done();
  });
}

function asText(msg: string | Buffer | ArrayBuffer): string {
  if (typeof msg === 'string') return msg;
  if (msg instanceof ArrayBuffer) return Buffer.from(msg).toString();
  return msg.toString();
}

describe.skipIf(!nativeMod)('TURN relay with node-datachannel / libjuice', () => {
  const fixtures: Array<{ close: () => void }> = [];
  let server: TurnServer | undefined;

  afterEach(async () => {
    while (fixtures.length) fixtures.pop()?.close();
    await server?.stop();
    server = undefined;
  });

  test('two relay-only PeerConnections exchange a DataChannel message through our TURN', async () => {
    const native = nativeMod as NativeMod;
    const begin = 24000 + Math.floor(Math.random() * 10000);
    server = createTurnServer({
      listenHost: '127.0.0.1',
      listenPort: 0,
      relayPortRange: { begin, end: begin + 40 },
      externalIp: '127.0.0.1',
      realm: 'vibeterm',
      credentials: (user) => (user === 'integration' ? 'integration-password' : null),
      deniedPeerCidrs: [],
    });
    const { port: turnPort } = await server.start();
    const ice = {
      iceServers: [
        {
          hostname: '127.0.0.1',
          port: turnPort,
          username: 'integration',
          password: 'integration-password',
          relayType: 'TurnUdp' as const,
        },
      ],
      iceTransportPolicy: 'relay' as const,
      bindAddress: '127.0.0.1',
    };
    const left = new native.PeerConnection('turn-left', ice);
    const right = new native.PeerConnection('turn-right', ice);
    fixtures.push({ close: () => left.close() });
    fixtures.push({ close: () => right.close() });
    couple(left, right);
    const received = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TURN message timeout')), 20_000);
      right.onDataChannel((dc) => {
        dc.onMessage((msg) => {
          clearTimeout(timer);
          resolve(asText(msg));
        });
      });
    });
    const dc = left.createDataChannel('turn-test');
    await waitOpen(dc, 20_000);
    expect(dc.sendMessage('turn-loopback')).toBe(true);
    expect(await received).toBe('turn-loopback');
    const stats = server.snapshot();
    console.log('turn snapshot', stats);
    expect(stats.allocations).toBeGreaterThanOrEqual(1);
    expect(stats.channels).toBeGreaterThanOrEqual(1);
    expect(stats.bytesRelayedOut).toBeGreaterThan(0);
  }, 45_000);
});
