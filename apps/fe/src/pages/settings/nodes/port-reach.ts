// 节点 / 本机卡 / 接入向导共用的端口可达形状。
// WP-G 尚未把 `MeshPortReach` 写进 api-client `types.ts` 时，FE 用这一份本地类型；字段均为可选探测结果。

import { getMeshNodesState } from '@/node/mesh-nodes';
import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_PEER_PORT,
  DEFAULT_PUBLIC_HTTPS_PORT,
  DEFAULT_TURN_PORT,
  DEFAULT_TURN_RELAY_PORT_RANGE,
  type PortPlanLive,
  type PortPurpose,
  type PortRange,
  type PortRole,
  type PortSpec,
  formatPortSpec,
  portPlanForRole,
  rolesIncludeRelay,
} from '@vibeterm/shared/net';

export type MeshPortReachStatus = 'open' | 'blocked' | 'unknown';

export type MeshPortReachCode = 'peer_refused' | 'peer_timeout' | 'no_srflx' | 'turn_unreachable';

export type MeshPortReach = {
  purpose: PortPurpose;
  proto: 'tcp' | 'udp';
  port?: number;
  range?: PortRange;
  status: MeshPortReachStatus;
  code?: MeshPortReachCode;
  checkedAt?: number;
};

export type LocalPortsTitleKey =
  | 'localMachine.ports.titleRelay'
  | 'localMachine.ports.titleHub'
  | 'localMachine.ports.titleNode';

export const DEFAULT_PORT_PLAN_LIVE: PortPlanLive = {
  gatewayPort: DEFAULT_GATEWAY_PORT,
  gatewayExposed: false,
  peerPort: DEFAULT_PEER_PORT,
  rtcRange: null,
  turnPort: DEFAULT_TURN_PORT,
  turnRelayRange: {
    begin: DEFAULT_TURN_RELAY_PORT_RANGE.begin,
    end: DEFAULT_TURN_RELAY_PORT_RANGE.end,
  },
  publicHttpsPort: DEFAULT_PUBLIC_HTTPS_PORT,
};

const PORT_ROLES: ReadonlySet<string> = new Set([
  'standalone',
  'node',
  'hub,node',
  'relay',
  'relay,node',
]);

const PURPOSES: ReadonlySet<string> = new Set([
  'gateway-http',
  'peer-signaling',
  'rtc-ice',
  'turn-control',
  'turn-relay',
  'public-https',
]);

const REACH_CODES: ReadonlySet<string> = new Set([
  'peer_refused',
  'peer_timeout',
  'no_srflx',
  'turn_unreachable',
]);

export function asPortRole(role: string | null | undefined, fallback: PortRole): PortRole {
  return role && PORT_ROLES.has(role) ? (role as PortRole) : fallback;
}

export function formatPortReach(reach: {
  proto: 'tcp' | 'udp';
  port?: number;
  range?: PortRange;
  purpose: PortPurpose;
}): string {
  return formatPortSpec({
    proto: reach.proto,
    port: reach.port,
    range: reach.range,
    purpose: reach.purpose,
    requiredFor: 'lan-direct',
    required: true,
  });
}

function parseRange(value: unknown): PortRange | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.begin !== 'number' || typeof raw.end !== 'number') return undefined;
  if (!Number.isFinite(raw.begin) || !Number.isFinite(raw.end)) return undefined;
  return { begin: raw.begin, end: raw.end };
}

function applyReachOptionals(reach: MeshPortReach, raw: Record<string, unknown>): void {
  if (typeof raw.port === 'number' && Number.isFinite(raw.port)) reach.port = raw.port;
  const range = parseRange(raw.range);
  if (range) reach.range = range;
  if (typeof raw.code === 'string' && REACH_CODES.has(raw.code)) {
    reach.code = raw.code as MeshPortReachCode;
  }
  if (typeof raw.checkedAt === 'number' && Number.isFinite(raw.checkedAt)) {
    reach.checkedAt = raw.checkedAt;
  }
}

function parsePortReach(value: unknown): MeshPortReach | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!PURPOSES.has(String(raw.purpose))) return null;
  if (raw.proto !== 'tcp' && raw.proto !== 'udp') return null;
  if (raw.status !== 'open' && raw.status !== 'blocked' && raw.status !== 'unknown') return null;
  const reach: MeshPortReach = {
    purpose: raw.purpose as PortPurpose,
    proto: raw.proto,
    status: raw.status,
  };
  applyReachOptionals(reach, raw);
  return reach;
}

/** `undefined` = 字段缺失（旧网关）；空数组 = 下发了但没有条目。 */
export function parsePortReachList(value: unknown): MeshPortReach[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: MeshPortReach[] = [];
  for (const item of value) {
    const parsed = parsePortReach(item);
    if (parsed) list.push(parsed);
  }
  return list;
}

export function blockedPortReaches(ports: MeshPortReach[] | undefined | null): MeshPortReach[] {
  return (ports ?? []).filter((item) => item.status === 'blocked');
}

export function resolveNodePorts(row: { id: string }): MeshPortReach[] | undefined {
  const fromRow = parsePortReachList((row as { ports?: unknown }).ports);
  if (fromRow !== undefined) return fromRow;
  const mesh = getMeshNodesState().nodes.find((node) => node.id === row.id);
  return parsePortReachList((mesh as { ports?: unknown } | undefined)?.ports);
}

export function parsePortPlan(value: unknown): PortSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: PortSpec[] = [];
  for (const item of value) {
    const spec = parsePortSpec(item);
    if (spec) list.push(spec);
  }
  return list;
}

function parsePortSpec(value: unknown): PortSpec | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!PURPOSES.has(String(raw.purpose))) return null;
  if (raw.proto !== 'tcp' && raw.proto !== 'udp') return null;
  const spec: PortSpec = {
    proto: raw.proto,
    purpose: raw.purpose as PortPurpose,
    requiredFor: requiredForOf(raw.requiredFor),
    required: raw.required !== false,
  };
  if (typeof raw.port === 'number' && Number.isFinite(raw.port)) spec.port = raw.port;
  const range = parseRange(raw.range);
  if (range) spec.range = range;
  return spec;
}

function requiredForOf(value: unknown): PortSpec['requiredFor'] {
  if (
    value === 'lan-direct' ||
    value === 'wan-direct' ||
    value === 'turn-fallback' ||
    value === 'public-entry'
  ) {
    return value;
  }
  return 'lan-direct';
}

/** 字段缺失时 `undefined`（调用方退回 `portPlanForRole`）；空数组原样返回。 */
export function portPlanFromStatus(status: unknown): PortSpec[] | undefined {
  if (!status || typeof status !== 'object' || !('portPlan' in status)) return undefined;
  return parsePortPlan((status as { portPlan?: unknown }).portPlan);
}

export function portPlanOrFallback(plan: PortSpec[] | undefined, role: PortRole): PortSpec[] {
  return plan ?? portPlanForRole(role, DEFAULT_PORT_PLAN_LIVE);
}

export function reachForPurpose(
  ports: MeshPortReach[] | undefined | null,
  purpose: PortPurpose
): MeshPortReach | undefined {
  return ports?.find((item) => item.purpose === purpose);
}

function endpointMatches(
  item: MeshPortReach,
  spec: Pick<PortSpec, 'proto' | 'port' | 'range'>
): boolean {
  if (item.proto !== spec.proto) return false;
  if (spec.port != null) return item.port === spec.port;
  if (spec.range) {
    return (
      item.range != null &&
      item.range.begin === spec.range.begin &&
      item.range.end === spec.range.end
    );
  }
  return item.port == null && item.range == null;
}

/** 计划行对上一条 purpose+port（或 range）才算有探测结果；对不上就当「不探测」。 */
export function reachForSpec(
  ports: MeshPortReach[] | undefined | null,
  spec: Pick<PortSpec, 'purpose' | 'proto' | 'port' | 'range'>
): MeshPortReach | undefined {
  return ports?.find((item) => item.purpose === spec.purpose && endpointMatches(item, spec));
}

export function localPortsTitleKey(role: string | null | undefined): LocalPortsTitleKey {
  if (role && rolesIncludeRelay(role)) return 'localMachine.ports.titleRelay';
  if (role === 'hub,node') return 'localMachine.ports.titleHub';
  return 'localMachine.ports.titleNode';
}
