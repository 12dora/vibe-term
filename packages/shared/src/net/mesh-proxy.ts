// 多节点互联出站代理：mesh / 中继 / 对端拨号默认直连，可改为走系统代理环境变量。
export const MESH_PROXY_MODES = ['direct', 'system'] as const;
export type MeshProxyMode = (typeof MESH_PROXY_MODES)[number];
export const DEFAULT_MESH_PROXY_MODE: MeshProxyMode = 'direct';

export function isMeshProxyMode(value: unknown): value is MeshProxyMode {
  return typeof value === 'string' && (MESH_PROXY_MODES as readonly string[]).includes(value);
}
