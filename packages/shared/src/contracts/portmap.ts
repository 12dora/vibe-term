// 端口映射契约（round 32）。映射记录保存在监听方 A（`port_maps`），目标方 B 保存对应的
// 放行记录（`port_map_exports`）；两条记录都由浏览器分别以各节点会话创建，A→B 的 tcp 流
// 只需 peer 身份 + mapId 匹配即可放行。

/** 租约时长范围与缺省续约时长（毫秒）：前台转发靠租约兜底，客户端失联后网关自动回收。 */
export const PORT_MAP_LEASE_MIN_MS = 30_000;
export const PORT_MAP_LEASE_MAX_MS = 600_000;
export const PORT_MAP_LEASE_DEFAULT_MS = 90_000;

export type PortMapState = 'listening' | 'paused' | 'error';

export type PortMapErrorCode =
  | 'invalid_request'
  | 'port_in_use'
  | 'port_reserved'
  | 'bind_failed'
  | 'not_found'
  | 'target_unreachable'
  | 'export_missing'
  | 'limit_reached';

export interface PortMapDto {
  id: string;
  name: string;
  /** 监听地址，默认 127.0.0.1；`0.0.0.0` 表示对 A 所在局域网开放 */
  listenHost: string;
  listenPort: number;
  targetNodeId: string;
  /** B 上被访问的地址，默认 127.0.0.1 */
  targetHost: string;
  targetPort: number;
  paused: boolean;
  state: PortMapState;
  /** state 为 error 时的原因 */
  error?: PortMapErrorCode;
  activeConnections: number;
  totalConnections: number;
  bytesIn: number;
  bytesOut: number;
  /** 泵队列里尚未交给 mux 的字节；运行期才有。 */
  pendingBytes?: number;
  createdAt: number;
  updatedAt: number;
  /** 租约到期时间（毫秒时间戳）；缺省表示持久映射。过期未续约的映射会被网关回收。 */
  leaseExpiresAt?: number;
}

export interface CreatePortMapRequest {
  name?: string;
  listenHost?: string;
  listenPort: number;
  targetNodeId: string;
  targetHost?: string;
  targetPort: number;
  /** 由浏览器先在 B 上创建放行记录得到的 id；A 侧记录与其同 id */
  mapId?: string;
  /** 租约时长（毫秒，30 s..10 min）；不传则为持久映射。 */
  leaseMs?: number;
}

export interface UpdatePortMapRequest {
  name?: string;
  paused?: boolean;
  /** 续约：按缺省时长（90 s）从现在起延长；仅对带租约的映射生效。 */
  renewLease?: boolean;
  /** 续约：从现在起延长到指定时长（毫秒，30 s..10 min）；可把持久映射改为带租约。 */
  leaseMs?: number;
}

export interface PortMapResponse {
  map: PortMapDto;
}

export interface ListPortMapsResponse {
  maps: PortMapDto[];
}

/** 端口占用探测：`GET /api/portmap/probe?host=&port=` */
export interface PortProbeResponse {
  host: string;
  port: number;
  /** 本机能否绑定该端口（true = 空闲） */
  free: boolean;
  /** 是否为 VibeTerm 自身或系统保留端口 */
  reserved: boolean;
  /** 已被本机某条映射占用时给出其 id */
  usedByMapId: string | null;
}

/** 目标节点 B 上的放行记录 */
export interface PortMapExportDto {
  /** 与 A 侧映射同 id */
  mapId: string;
  fromNodeId: string;
  host: string;
  port: number;
  enabled: boolean;
  createdAt: number;
  /** 租约到期时间（毫秒时间戳）；缺省表示持久放行。过期后不再放行并被回收。 */
  leaseExpiresAt?: number;
}

export interface CreatePortMapExportRequest {
  mapId?: string;
  fromNodeId: string;
  host?: string;
  port: number;
  /** 租约时长（毫秒，30 s..10 min）；不传则为持久放行。 */
  leaseMs?: number;
}

export interface UpdatePortMapExportRequest {
  renewLease?: boolean;
  leaseMs?: number;
}

export interface PortMapExportResponse {
  export: PortMapExportDto;
}

export interface ListPortMapExportsResponse {
  exports: PortMapExportDto[];
}

/** B 上目标端口是否有服务在监听：`GET /api/portmap/target-probe?host=&port=` */
export interface TargetPortProbeResponse {
  host: string;
  port: number;
  listening: boolean;
}
