import type { PortMapErrorCode } from '@vibeterm/shared';
import type { LinkSession } from '@vibeterm/shared/link';

/** A 侧持久化的映射行。 */
export type PortMapRow = {
  id: string;
  name: string;
  listenHost: string;
  listenPort: number;
  targetNodeId: string;
  targetHost: string;
  targetPort: number;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
};

/** B 侧持久化的放行行。 */
export type PortMapExportRow = {
  mapId: string;
  fromNodeId: string;
  host: string;
  port: number;
  enabled: boolean;
  createdAt: number;
};

export type PortMapPeers = {
  getLink(nodeId: string): Promise<LinkSession>;
};

/** 单条映射的运行期计数。 */
export type PortMapCounters = {
  activeConnections: number;
  totalConnections: number;
  bytesIn: number;
  bytesOut: number;
};

export function createPortMapCounters(): PortMapCounters {
  return { activeConnections: 0, totalConnections: 0, bytesIn: 0, bytesOut: 0 };
}

/** 单条映射的并发连接上限。真正兜底的是下面按 peer 链路算的共享名额。 */
export const PORT_MAP_MAX_CONNECTIONS = 64;
/**
 * 每条 peer 链路上端口映射流的总并发上限（A 侧指向同一节点的全部映射 + B 侧来自同一对端的全部
 * 入站流）。mux 的 MAX_LINK_UNACKED 是 65 个满窗，留 17 个给 ctl / 终端 / 文件传输。
 */
export const PORT_MAP_MAX_PEER_STREAMS = 48;
export const PORT_MAP_MAX_ROWS = 64;
export const PORT_MAP_CONNECT_TIMEOUT_MS = 5_000;
/** getLink + openStream 的总时限：拨号期间 socket 是暂停的，不能无限期占着名额。 */
export const PORT_MAP_DIAL_DEADLINE_MS = 15_000;
export const PORT_MAP_TARGET_PROBE_TIMEOUT_MS = 1_500;

export class PortMapError extends Error {
  constructor(
    readonly code: PortMapErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PortMapError';
  }
}

export function portMapHttpStatus(code: PortMapErrorCode): number {
  switch (code) {
    case 'invalid_request':
      return 400;
    case 'not_found':
      return 404;
    case 'port_in_use':
    case 'port_reserved':
    case 'limit_reached':
      return 409;
    case 'bind_failed':
    case 'target_unreachable':
    case 'export_missing':
      return 500;
    default:
      return 500;
  }
}

const NODE_ID_RE = /^[0-9a-f]{32}$/;
const MAP_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HOST_RE = /^[A-Za-z0-9._:-]{1,255}$/;

export function assertNodeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !NODE_ID_RE.test(value)) {
    throw new PortMapError('invalid_request', `${field} must be a node id`);
  }
  return value;
}

export function assertMapId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !MAP_ID_RE.test(value)) {
    throw new PortMapError('invalid_request', `${field} must be 8-64 url-safe characters`);
  }
  return value;
}

export function assertPort(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new PortMapError('invalid_request', `${field} must be a port between 1 and 65535`);
  }
  return value;
}

export function assertHost(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HOST_RE.test(value)) {
    throw new PortMapError('invalid_request', `${field} is not a valid host`);
  }
  return value;
}

export function assertName(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new PortMapError('invalid_request', `${field} must be a string`);
  }
  const name = value.trim();
  if (name.length > 64) {
    throw new PortMapError('invalid_request', `${field} must be at most 64 characters`);
  }
  return name;
}
