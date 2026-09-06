// 端口映射契约（round 32）。映射记录保存在监听方 A（`port_maps`），目标方 B 保存对应的
// 放行记录（`port_map_exports`）；两条记录都由浏览器分别以各节点会话创建，A→B 的 tcp 流
// 只需 peer 身份 + mapId 匹配即可放行。

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
  createdAt: number;
  updatedAt: number;
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
}

export interface UpdatePortMapRequest {
  name?: string;
  paused?: boolean;
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
}

export interface CreatePortMapExportRequest {
  mapId?: string;
  fromNodeId: string;
  host?: string;
  port: number;
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
