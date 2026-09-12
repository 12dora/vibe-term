import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Allocation, ChannelBinding } from './allocation-table';
import { peerKey } from './allocation-table';
import { normalizePeerAddress } from './denied-peers';
import {
  ATTR,
  CLASS,
  METHOD,
  type StunMessage,
  addressAttribute,
  decodeAddress,
  decodeChannelData,
  encodeChannelData,
  encodeMessage,
  getAttribute,
  maxDataIndicationPayload,
} from './stun-message';
import type { SocketAddress, TurnContext } from './turn-context';
import { MAX_CHANNEL_DATA_PAYLOAD } from './turn-limits';

export function consumeTokens(
  allocation: Allocation,
  bytes: number,
  now: number,
  rate: number
): boolean {
  if (!rate) return true;
  const elapsed = Math.max(0, now - allocation.tokenAt) / 1000;
  allocation.tokens = Math.min(rate, allocation.tokens + elapsed * rate);
  allocation.tokenAt = now;
  if (allocation.tokens < bytes) return false;
  allocation.tokens -= bytes;
  return true;
}

export function isDeniedPeer(ctx: TurnContext, ip: string, port: number): boolean {
  if (matchDenied(ctx, ip)) return true;
  if (port !== ctx.stats.port) return false;
  const host = ctx.options.listenHost;
  if (host === '0.0.0.0' || host === '::') return true;
  return sameAddress(ip, host);
}

function matchDenied(ctx: TurnContext, ip: string): boolean {
  try {
    return ctx.denied(ip);
  } catch {
    return true;
  }
}

function sameAddress(left: string, right: string): boolean {
  try {
    return normalizePeerAddress(left) === normalizePeerAddress(right);
  } catch {
    return true;
  }
}

export function hasLivePermission(
  allocation: Allocation,
  address: string,
  port: number,
  now: number
): boolean {
  const permission = allocation.permissions.get(peerKey(address, port));
  return !!permission && permission.expiresAt > now;
}

export function handleSendIndication(
  ctx: TurnContext,
  msg: StunMessage,
  addr: SocketAddress
): void {
  const allocation = ctx.table.getByClient(addr);
  if (!allocation) return;
  const rawPeer = getAttribute(msg, ATTR.XOR_PEER_ADDRESS);
  const data = getAttribute(msg, ATTR.DATA);
  const peer = rawPeer ? decodeAddress(rawPeer, msg.transactionId) : null;
  if (!peer || !data) return;
  forwardClientToPeer(ctx, allocation, data, peer.address, peer.port);
}

export function handleClientChannelData(ctx: TurnContext, buf: Buffer, addr: SocketAddress): void {
  const decoded = decodeChannelData(buf);
  if (!decoded) return;
  const allocation = ctx.table.getByClient(addr);
  if (!allocation) return;
  const now = ctx.options.now();
  const channel = allocation.channels.get(decoded.channel);
  if (!channel || channel.expiresAt <= now) return;
  forwardClientToPeer(ctx, allocation, decoded.data, channel.address, channel.port);
}

export function guardTurnHandler(ctx: TurnContext, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    ctx.stats.droppedOversized++;
    const text = err instanceof Error ? err.message : String(err);
    ctx.options.log(`turn: drop ${text}`);
  }
}

export function handlePeerDatagram(
  ctx: TurnContext,
  allocation: Allocation,
  buf: Buffer,
  peer: SocketAddress
): void {
  const now = ctx.options.now();
  if (isDeniedPeer(ctx, peer.address, peer.port)) {
    ctx.stats.deniedPeers++;
    return;
  }
  if (!hasLivePermission(allocation, peer.address, peer.port, now)) {
    ctx.stats.droppedNoPermission++;
    return;
  }
  const channel = liveChannel(allocation, peer, now);
  if (buf.length > maxPeerPayload(peer, !!channel)) {
    ctx.stats.droppedOversized++;
    return;
  }
  if (!consumeTokens(allocation, buf.length, now, ctx.options.bytesPerSecPerAllocation)) {
    ctx.stats.droppedRateLimit++;
    return;
  }
  const out = encodePeerToClient(allocation, buf, peer, now, channel);
  ctx.send(out, allocation.client);
  ctx.stats.bytesRelayedIn += buf.length;
}

function forwardClientToPeer(
  ctx: TurnContext,
  allocation: Allocation,
  data: Buffer,
  ip: string,
  port: number
): void {
  const now = ctx.options.now();
  if (isDeniedPeer(ctx, ip, port)) {
    ctx.stats.deniedPeers++;
    return;
  }
  if (!hasLivePermission(allocation, ip, port, now)) {
    ctx.stats.droppedNoPermission++;
    return;
  }
  if (isIP(ip) !== 4) return;
  if (!consumeTokens(allocation, data.length, now, ctx.options.bytesPerSecPerAllocation)) {
    ctx.stats.droppedRateLimit++;
    return;
  }
  allocation.socket.send(data, port, ip);
  ctx.stats.bytesRelayedOut += data.length;
}

function encodePeerToClient(
  allocation: Allocation,
  buf: Buffer,
  peer: SocketAddress,
  now: number,
  channel = liveChannel(allocation, peer, now)
): Buffer {
  if (channel) return encodeChannelData(channel.number, buf);
  const tx = randomBytes(12);
  return encodeMessage({
    method: METHOD.DATA,
    class: CLASS.INDICATION,
    transactionId: tx,
    attributes: [
      addressAttribute(ATTR.XOR_PEER_ADDRESS, { address: peer.address, port: peer.port }, tx),
      { type: ATTR.DATA, value: buf },
    ],
    fingerprint: true,
  });
}

function liveChannel(
  allocation: Allocation,
  peer: SocketAddress,
  now: number
): ChannelBinding | undefined {
  const number = allocation.peerToChannel.get(peerKey(peer.address, peer.port));
  if (number === undefined) return undefined;
  const channel = allocation.channels.get(number);
  if (!channel || channel.expiresAt <= now) return undefined;
  return channel;
}

function maxPeerPayload(peer: SocketAddress, hasChannel: boolean): number {
  if (hasChannel) return MAX_CHANNEL_DATA_PAYLOAD;
  return maxDataIndicationPayload(isIP(peer.address) === 6 ? 6 : 4);
}
