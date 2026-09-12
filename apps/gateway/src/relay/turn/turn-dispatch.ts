import { isIP } from 'node:net';
import { clientKey } from './allocation-table';
import {
  ATTR,
  CLASS,
  METHOD,
  type StunAddress,
  type StunAttribute,
  type StunMessage,
  addressAttribute,
  decodeAddress,
  encodeMessage,
  errorAttribute,
  getAttribute,
  getAttributes,
  uint32Attribute,
} from './stun-message';
import { type AuthOk, authenticateRequest, sendChallenge } from './turn-auth';
import type { SocketAddress, TurnContext } from './turn-context';
import {
  CHANNEL_MAX,
  CHANNEL_MIN,
  DEFAULT_LIFETIME_SEC,
  UDP_PROTOCOL,
  grantLifetimeSec,
} from './turn-limits';
import { handlePeerDatagram, handleSendIndication, isDeniedPeer } from './turn-relay-io';

const ERROR_REASON: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  437: 'Allocation Mismatch',
  442: 'Unsupported Transport Protocol',
  486: 'Allocation Quota Reached',
  508: 'Insufficient Capacity',
};

export function sendStun(
  ctx: TurnContext,
  msg: StunMessage,
  addr: SocketAddress,
  cls: number,
  attrs: readonly StunAttribute[] | undefined,
  key?: Buffer
): void {
  ctx.send(
    encodeMessage({
      method: msg.method,
      class: cls,
      transactionId: msg.transactionId,
      attributes: attrs,
      integrityKey: key,
      fingerprint: true,
    }),
    addr
  );
}

export function sendError(
  ctx: TurnContext,
  msg: StunMessage,
  addr: SocketAddress,
  code: number,
  key?: Buffer
): void {
  sendStun(ctx, msg, addr, CLASS.ERROR, [errorAttribute(code, ERROR_REASON[code] ?? 'Error')], key);
}

export function dispatchStun(ctx: TurnContext, msg: StunMessage, addr: SocketAddress): void {
  if (msg.class === CLASS.INDICATION) {
    if (msg.method === METHOD.SEND) handleSendIndication(ctx, msg, addr);
    return;
  }
  if (msg.class !== CLASS.REQUEST) return;
  if (msg.method === METHOD.BINDING) {
    handleBinding(ctx, msg, addr);
    return;
  }
  const auth = authenticateRequest(msg, ctx.options.realm, ctx.options.credentials, ctx.nonce);
  if (!auth.ok) {
    sendChallenge(ctx, msg, addr, auth.code);
    return;
  }
  dispatchAuthenticated(ctx, msg, addr, auth);
}

function dispatchAuthenticated(
  ctx: TurnContext,
  msg: StunMessage,
  addr: SocketAddress,
  auth: AuthOk
): void {
  if (msg.method === METHOD.ALLOCATE) {
    void handleAllocate(ctx, msg, addr, auth);
    return;
  }
  if (msg.method === METHOD.REFRESH) {
    handleRefresh(ctx, msg, addr, auth);
    return;
  }
  if (msg.method === METHOD.CREATE_PERMISSION) {
    handleCreatePermission(ctx, msg, addr, auth);
    return;
  }
  if (msg.method === METHOD.CHANNEL_BIND) {
    handleChannelBind(ctx, msg, addr, auth);
    return;
  }
  sendError(ctx, msg, addr, 400, auth.key);
}

function handleBinding(ctx: TurnContext, msg: StunMessage, addr: SocketAddress): void {
  ctx.stats.bindingRequests++;
  sendStun(
    ctx,
    msg,
    addr,
    CLASS.SUCCESS,
    [
      addressAttribute(
        ATTR.XOR_MAPPED_ADDRESS,
        { address: addr.address, port: addr.port },
        msg.transactionId
      ),
    ],
    undefined
  );
}

function validateAllocate(msg: StunMessage): number | null {
  if (getAttribute(msg, ATTR.EVEN_PORT) || getAttribute(msg, ATTR.RESERVATION_TOKEN)) return 400;
  const transport = getAttribute(msg, ATTR.REQUESTED_TRANSPORT);
  if (!transport) return 400;
  if (transport[0] !== UDP_PROTOCOL) return 442;
  return null;
}

function readLifetime(msg: StunMessage): number | undefined {
  const attr = getAttribute(msg, ATTR.LIFETIME);
  if (!attr || attr.length < 4) return undefined;
  return attr.readUInt32BE(0);
}

async function handleAllocate(
  ctx: TurnContext,
  msg: StunMessage,
  addr: SocketAddress,
  auth: AuthOk
): Promise<void> {
  const key = clientKey(addr);
  if (ctx.table.get(key)) {
    sendError(ctx, msg, addr, 437, auth.key);
    return;
  }
  if (ctx.table.overQuota(auth.user)) {
    sendError(ctx, msg, addr, 486, auth.key);
    return;
  }
  const invalid = validateAllocate(msg);
  if (invalid) {
    sendError(ctx, msg, addr, invalid, auth.key);
    return;
  }
  await finishAllocate(ctx, msg, addr, auth, key);
}

async function finishAllocate(
  ctx: TurnContext,
  msg: StunMessage,
  addr: SocketAddress,
  auth: AuthOk,
  key: string
): Promise<void> {
  const bound = await ctx.table.tryBindRelay();
  if (!bound) {
    sendError(ctx, msg, addr, 508, auth.key);
    return;
  }
  const raced = racedAllocateError(ctx, key, auth.user);
  if (raced) {
    bound.socket.close();
    sendError(ctx, msg, addr, raced, auth.key);
    return;
  }
  const lifetime = grantLifetimeSec(readLifetime(msg), ctx.options.maxLifetimeSec);
  const granted = lifetime === 0 ? DEFAULT_LIFETIME_SEC : lifetime;
  const allocation = ctx.table.insert({
    key,
    user: auth.user,
    password: auth.password,
    client: addr,
    socket: bound.socket,
    relayPort: bound.port,
    lifetimeSec: granted,
  });
  bound.socket.on('message', (buf, peer) =>
    handlePeerDatagram(ctx, allocation, buf, { address: peer.address, port: peer.port })
  );
  bound.socket.on('error', () => ctx.table.remove(allocation));
  ctx.options.log(`turn: allocate ${auth.user} relay ${bound.port}`);
  sendStun(
    ctx,
    msg,
    addr,
    CLASS.SUCCESS,
    allocateSuccessAttrs(ctx, msg, addr, bound.port, granted),
    auth.key
  );
}

function racedAllocateError(ctx: TurnContext, key: string, user: string): number | null {
  if (ctx.table.get(key)) return 437;
  if (ctx.table.overQuota(user)) return 486;
  return null;
}

function allocateSuccessAttrs(
  ctx: TurnContext,
  msg: StunMessage,
  addr: SocketAddress,
  relayPort: number,
  lifetime: number
) {
  const tx = msg.transactionId;
  return [
    addressAttribute(
      ATTR.XOR_RELAYED_ADDRESS,
      { address: ctx.options.externalIp, port: relayPort },
      tx
    ),
    addressAttribute(ATTR.XOR_MAPPED_ADDRESS, { address: addr.address, port: addr.port }, tx),
    uint32Attribute(ATTR.LIFETIME, lifetime),
  ];
}

function handleRefresh(
  ctx: TurnContext,
  msg: StunMessage,
  addr: SocketAddress,
  auth: AuthOk
): void {
  const allocation = ctx.table.getByClient(addr);
  if (!allocation) {
    sendError(ctx, msg, addr, 437, auth.key);
    return;
  }
  const requested = readLifetime(msg) ?? DEFAULT_LIFETIME_SEC;
  if (requested === 0) {
    ctx.table.remove(allocation);
    sendStun(ctx, msg, addr, CLASS.SUCCESS, [uint32Attribute(ATTR.LIFETIME, 0)], auth.key);
    return;
  }
  const granted = grantLifetimeSec(requested, ctx.options.maxLifetimeSec);
  allocation.expiresAt = ctx.options.now() + granted * 1000;
  allocation.password = auth.password;
  sendStun(ctx, msg, addr, CLASS.SUCCESS, [uint32Attribute(ATTR.LIFETIME, granted)], auth.key);
}

function parseXorPeers(msg: StunMessage): StunAddress[] | null {
  const values = getAttributes(msg, ATTR.XOR_PEER_ADDRESS);
  if (values.length === 0) return null;
  const peers: StunAddress[] = [];
  for (const value of values) {
    const peer = decodeAddress(value, msg.transactionId);
    if (!peer || isIP(peer.address) !== 4) return null;
    peers.push(peer);
  }
  return peers;
}

function handleCreatePermission(
  ctx: TurnContext,
  msg: StunMessage,
  addr: SocketAddress,
  auth: AuthOk
): void {
  const allocation = ctx.table.getByClient(addr);
  if (!allocation) {
    sendError(ctx, msg, addr, 437, auth.key);
    return;
  }
  const peers = parseXorPeers(msg);
  if (!peers) {
    sendError(ctx, msg, addr, 400, auth.key);
    return;
  }
  if (rejectDenied(ctx, msg, addr, auth, peers)) return;
  const now = ctx.options.now();
  for (const peer of peers) ctx.table.installPermission(allocation, peer.address, peer.port, now);
  sendStun(ctx, msg, addr, CLASS.SUCCESS, [], auth.key);
}

function rejectDenied(
  ctx: TurnContext,
  msg: StunMessage,
  addr: SocketAddress,
  auth: AuthOk,
  peers: StunAddress[]
): boolean {
  for (const peer of peers) {
    if (!isDeniedPeer(ctx, peer.address, peer.port)) continue;
    ctx.stats.deniedPeers++;
    sendError(ctx, msg, addr, 403, auth.key);
    return true;
  }
  return false;
}

function handleChannelBind(
  ctx: TurnContext,
  msg: StunMessage,
  addr: SocketAddress,
  auth: AuthOk
): void {
  const allocation = ctx.table.getByClient(addr);
  if (!allocation) {
    sendError(ctx, msg, addr, 437, auth.key);
    return;
  }
  const parsed = parseChannelBind(msg);
  if (!parsed) {
    sendError(ctx, msg, addr, 400, auth.key);
    return;
  }
  if (rejectDenied(ctx, msg, addr, auth, [parsed.peer])) return;
  const result = ctx.table.bindChannel(
    allocation,
    parsed.channel,
    parsed.peer.address,
    parsed.peer.port,
    ctx.options.now()
  );
  if (result === 'conflict') {
    sendError(ctx, msg, addr, 400, auth.key);
    return;
  }
  sendStun(ctx, msg, addr, CLASS.SUCCESS, [], auth.key);
}

function parseChannelBind(msg: StunMessage): { peer: StunAddress; channel: number } | null {
  const peers = parseXorPeers(msg);
  const raw = getAttribute(msg, ATTR.CHANNEL_NUMBER);
  if (!peers || peers.length !== 1 || !raw || raw.length < 4) return null;
  if (raw.readUInt16BE(2) !== 0) return null;
  const channel = raw.readUInt16BE(0);
  if (channel < CHANNEL_MIN || channel > CHANNEL_MAX) return null;
  const peer = peers[0];
  if (!peer) return null;
  return { peer, channel };
}
