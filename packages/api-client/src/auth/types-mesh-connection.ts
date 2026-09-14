import { CONNECTION_HEADER } from '@vibeterm/shared/http/mesh-headers';

/** 把请求绑到本标签页的那条 Gateway WS；新旧两个头名同时发送（混合版本桥）。 */
export { CONNECTION_HEADER };

/** `GET /api/mesh/connection` 的 200 响应。 */
export interface MeshConnectionResponse {
  connectionId: string;
}

/**
 * `NO_CONNECTION`：该 sid 在目标 node 上没有 live 的 Gateway WS（primary 还没连上 / 刚断）。
 * `MULTIPLE_CONNECTIONS`：同 sid 有多条（多标签），必须带 connection 头才能定位。
 */
export type MeshConnectionErrorCode = 'NO_CONNECTION' | 'MULTIPLE_CONNECTIONS';

export type MeshConnectionResult =
  | { ok: true; connectionId: string }
  | { ok: false; status: number; code: MeshConnectionErrorCode | string };
