import { type LinkSession, type LinkStream, createInMemoryLinkPair } from '@vibeterm/shared/link';
import type { MeshUplinkCtlMessage } from '@vibeterm/shared/uplink';
import type { UserStore } from '../auth/user-store';
import type { InboundRelayHandler, PooledUplink, UplinkState } from './types';
import type { UplinkWsFactory } from './uplink-constants';

class DummyPooledUplink implements PooledUplink {
  readonly identity: { nodeId: string; edSecretKey: Uint8Array };
  readonly userId = 'user-1';
  readonly hubUrl = 'https://relay.example.com';
  lastKeyLogHead: { seq: bigint; hash: Uint8Array } | null = null;
  state: UplinkState = 'offline';
  link: LinkSession | null = null;
  lastConnectError: { reason: string; at: number } | null = null;
  openRelayImpl: (() => Promise<LinkStream>) | null = null;
  private _relayHandler: InboundRelayHandler | null = null;

  constructor(
    identity: { nodeId: string; edSecretKey: Uint8Array },
    openRelay?: () => Promise<LinkStream>
  ) {
    this.identity = identity;
    this.openRelayImpl = openRelay ?? null;
    if (openRelay) {
      this.state = 'online';
      this.link = createInMemoryLinkPair()[0];
    }
  }

  onStateChange(_cb: (state: UplinkState) => void): () => void {
    return () => {};
  }
  setOnRelayStream(handler: InboundRelayHandler | null): void {
    this._relayHandler = handler;
  }
  async attemptConnect(): Promise<void> {}
  async connectWithLink(): Promise<void> {}
  async waitUntilClosed(): Promise<void> {}
  async stop(): Promise<void> {
    this.state = 'offline';
  }
  sendCtl(_msg: MeshUplinkCtlMessage): void {}
  sendStatus(): void {}
  sendStatusIfChanged(): boolean {
    return false;
  }
  async openRelay(_toNodeId: string): Promise<LinkStream> {
    if (!this.openRelayImpl) throw new Error('dummy uplink has no relay');
    return this.openRelayImpl();
  }
  async queryHubHead() {
    return this.lastKeyLogHead;
  }
  async queryKeyLogAt() {
    return null;
  }
  async appendAndAck() {
    return { ok: false, error: 'dummy' };
  }
  requestCatchUpNow(): void {}
  resetBackoff(): void {}
}

export function dummyUplink(
  identity: { nodeId: string; edSecretKey: Uint8Array },
  _userStore: UserStore,
  openRelay?: () => Promise<LinkStream>,
  _options?: { wsFactory?: UplinkWsFactory }
): DummyPooledUplink {
  return new DummyPooledUplink(identity, openRelay);
}

export function echoQuiesceCaps(session: LinkSession): void {
  let helloReplied = false;
  session.ctl.onMessage((bytes) => {
    let msg: { t?: string };
    try {
      msg = JSON.parse(new TextDecoder().decode(bytes)) as { t?: string };
    } catch {
      return;
    }
    if (msg.t === 'link.hello' && !helloReplied) {
      helloReplied = true;
      session.ctl.send(
        new TextEncoder().encode(JSON.stringify({ t: 'link.hello', caps: ['quiesce'] }))
      );
    }
    if (msg.t === 'link.quiesce.probe') {
      session.ctl.send(new TextEncoder().encode(JSON.stringify({ t: 'link.quiesce.probe.ack' })));
    }
  });
}
