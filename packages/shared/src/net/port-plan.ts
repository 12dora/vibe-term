// 舰队入站端口计划：角色 → 应放行的端口清单，以及统一默认常量。
// 模块必须保持浏览器安全（不引 `node:*`、不读 `process.env`）：前端 bundle 会带上 `@vibeterm/shared/net`。

export const DEFAULT_GATEWAY_PORT = 9883;
export const DEFAULT_PEER_PORT = 39001;
export const DEFAULT_RTC_PORT_RANGE = { begin: 40000, end: 40099 } as const;
export const DEFAULT_TURN_PORT = 3478;
export const DEFAULT_TURN_RELAY_PORT_RANGE = { begin: 49160, end: 49259 } as const;
export const DEFAULT_TLS_PORT = 9443;
export const DEFAULT_PUBLIC_HTTPS_PORT = 443;

export type PortProto = 'tcp' | 'udp';
export type PortRole = 'standalone' | 'node' | 'hub,node' | 'relay' | 'relay,node';
export type PortPurpose =
  | 'gateway-http'
  | 'peer-signaling'
  | 'rtc-ice'
  | 'turn-control'
  | 'turn-relay'
  | 'public-https';
export type PortRange = { begin: number; end: number };
export type PortSpec = {
  proto: PortProto;
  port?: number;
  range?: PortRange;
  purpose: PortPurpose;
  requiredFor: 'lan-direct' | 'wan-direct' | 'turn-fallback' | 'public-entry';
  envKey?: string;
  required: boolean;
};
export type PortPlanLive = {
  gatewayPort: number;
  gatewayExposed: boolean;
  peerPort: number;
  rtcRange: PortRange | null;
  turnPort: number | 0;
  turnRelayRange: PortRange;
  publicHttpsPort: number | null;
};

const NODE_ROLES: ReadonlySet<PortRole> = new Set(['standalone', 'node', 'hub,node', 'relay,node']);
const PUBLIC_HTTPS_ROLES: ReadonlySet<PortRole> = new Set(['hub,node', 'relay', 'relay,node']);
const TURN_ROLES: ReadonlySet<PortRole> = new Set(['relay', 'relay,node']);

function copyRange(range: PortRange): PortRange {
  return { begin: range.begin, end: range.end };
}

function publicHttpsSpec(live: PortPlanLive): PortSpec {
  return {
    proto: 'tcp',
    port: live.publicHttpsPort ?? DEFAULT_PUBLIC_HTTPS_PORT,
    purpose: 'public-https',
    requiredFor: 'public-entry',
    required: true,
  };
}

function peerSpec(live: PortPlanLive, required: boolean): PortSpec {
  return {
    proto: 'tcp',
    port: live.peerPort,
    purpose: 'peer-signaling',
    requiredFor: 'lan-direct',
    envKey: 'VIBETERM_PEER_PORT',
    required,
  };
}

function rtcSpec(live: PortPlanLive, required: boolean): PortSpec {
  return {
    proto: 'udp',
    range: copyRange(live.rtcRange ?? DEFAULT_RTC_PORT_RANGE),
    purpose: 'rtc-ice',
    requiredFor: 'wan-direct',
    envKey: 'VIBETERM_RTC_PORT_RANGE',
    required,
  };
}

function turnControlSpec(live: PortPlanLive): PortSpec {
  return {
    proto: 'udp',
    port: live.turnPort,
    purpose: 'turn-control',
    requiredFor: 'turn-fallback',
    envKey: 'VIBETERM_TURN_PORT',
    required: true,
  };
}

function turnRelaySpec(live: PortPlanLive): PortSpec {
  return {
    proto: 'udp',
    range: copyRange(live.turnRelayRange),
    purpose: 'turn-relay',
    requiredFor: 'turn-fallback',
    envKey: 'VIBETERM_TURN_RELAY_PORT_RANGE',
    required: true,
  };
}

function gatewaySpec(live: PortPlanLive): PortSpec {
  return {
    proto: 'tcp',
    port: live.gatewayPort,
    purpose: 'gateway-http',
    requiredFor: 'public-entry',
    envKey: 'GATEWAY_PORT',
    required: true,
  };
}

/** 按角色列出入站端口，顺序：公网 HTTPS、peer、RTC、TURN 控制、TURN 中继、网关（仅暴露时）。 */
export function portPlanForRole(role: PortRole, live: PortPlanLive): PortSpec[] {
  const specs: PortSpec[] = [];
  const nodeRequired = role !== 'standalone';
  if (PUBLIC_HTTPS_ROLES.has(role)) specs.push(publicHttpsSpec(live));
  if (NODE_ROLES.has(role)) {
    specs.push(peerSpec(live, nodeRequired), rtcSpec(live, nodeRequired));
  }
  // 内置 TURN 关闭（turnPort=0）时不列 TURN 口，否则防火墙提示会带上 0/udp 这种无效规则
  if (TURN_ROLES.has(role) && live.turnPort !== 0)
    specs.push(turnControlSpec(live), turnRelaySpec(live));
  if (live.gatewayExposed) specs.push(gatewaySpec(live));
  return specs;
}

export function formatPortSpec(spec: PortSpec): string {
  if (spec.range) return `${spec.range.begin}-${spec.range.end}/${spec.proto}`;
  return `${spec.port}/${spec.proto}`;
}

export function formatPortList(specs: PortSpec[]): string {
  return specs.map(formatPortSpec).join(', ');
}

/** `'a-b'`：trim 后允许连字符两侧空白；须有序且落在 1..65535，否则 `null`。 */
export function parsePortRange(text: string): PortRange | null {
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(text.trim());
  if (!match?.[1] || !match[2]) return null;
  const begin = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isInteger(begin) ||
    !Number.isInteger(end) ||
    begin < 1 ||
    end > 65535 ||
    begin > end
  ) {
    return null;
  }
  return { begin, end };
}
