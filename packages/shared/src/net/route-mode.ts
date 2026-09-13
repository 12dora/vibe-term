// 多节点互联「延迟优化」选路模式：本机作为发起方时，对每个对端在直连与中继之间如何取舍。
export const MESH_ROUTE_MODES = ['auto', 'direct', 'relay'] as const;
export type MeshRouteMode = (typeof MESH_ROUTE_MODES)[number];
export const DEFAULT_MESH_ROUTE_MODE: MeshRouteMode = 'auto';

export function isMeshRouteMode(value: unknown): value is MeshRouteMode {
  return typeof value === 'string' && (MESH_ROUTE_MODES as readonly string[]).includes(value);
}

/** 流的延迟敏感度：终端 / 指令 / 端口映射按 interactive，文件传输等大流量按 bulk。 */
export type MeshStreamClass = 'interactive' | 'bulk';
export type MeshPathKind = 'direct' | 'relay';
