export type PeerRouteRecord = {
  consecutiveSlow: number;
  firstSlowAt: number | null;
  backoffUntil: number;
  backoffMs: number;
  degraded: boolean;
};

export function emptyRouteRecord(): PeerRouteRecord {
  return {
    consecutiveSlow: 0,
    firstSlowAt: null,
    backoffUntil: 0,
    backoffMs: 0,
    degraded: false,
  };
}

export function formatRouteSwitch(input: {
  peer: string;
  from: string;
  to: string;
  directMs: number | null;
  relayMs: number | null;
}): string {
  const direct = input.directMs == null ? '-' : String(Math.round(input.directMs));
  const relay = input.relayMs == null ? '-' : String(Math.round(input.relayMs));
  return `route_switch peer=${input.peer} from=${input.from} to=${input.to} direct_ms=${direct} relay_ms=${relay}`;
}
