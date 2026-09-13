import { type MeshNode, wsBorsh } from '@vibeterm/shared';

const STATUS_TO_U8: Record<string, number> = {
  online: wsBorsh.NODE_EVENT_STATUS_ONLINE,
  offline: wsBorsh.NODE_EVENT_STATUS_OFFLINE,
  revoked: wsBorsh.NODE_EVENT_STATUS_REVOKED,
};

export type NodeEventWireInput = {
  nodeId: string;
  status: string;
  reach?: MeshNode['reach'];
  transport?: MeshNode['transport'];
  rttMs?: MeshNode['rttMs'];
  inventory?: string | null;
  version?: MeshNode['version'];
  direct_capable?: MeshNode['direct_capable'];
  name?: MeshNode['name'];
  viaRelay?: MeshNode['viaRelay'];
  relayPresence?: MeshNode['relayPresence'] | null;
  paused?: MeshNode['paused'];
};

export type NodeEventRelayLookup = {
  viaRelayOf?(nodeId: string): string | null;
  relayPresenceOf?(nodeId: string): string[] | undefined;
  linkDetailOf?(nodeId: string): { viaRelay?: string | null; relayPresence?: string[] } | null;
};

export function encodeNodeEventFrame(
  event: NodeEventWireInput,
  seq: number,
  lookup?: NodeEventRelayLookup
): Uint8Array {
  const viaRelay =
    event.viaRelay ??
    lookup?.viaRelayOf?.(event.nodeId) ??
    lookup?.linkDetailOf?.(event.nodeId)?.viaRelay ??
    null;
  const relayPresence =
    event.relayPresence ??
    lookup?.relayPresenceOf?.(event.nodeId) ??
    lookup?.linkDetailOf?.(event.nodeId)?.relayPresence ??
    null;
  const payload = wsBorsh.encodeNodeEvent({
    nodeId: event.nodeId,
    status: STATUS_TO_U8[event.status] ?? wsBorsh.NODE_EVENT_STATUS_OFFLINE,
    reach: event.reach ?? null,
    inventory: event.inventory ?? null,
    version: event.version ?? null,
    directCapable: event.direct_capable ?? null,
    name: event.name ?? null,
    transport: event.transport ?? null,
    rttMs: event.rttMs ?? null,
    viaRelay,
    relayPresence,
    paused: event.paused,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_NODE_EVENT, payload, seq);
}
