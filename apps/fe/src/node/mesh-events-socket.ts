// `/mesh/ws` 的 socket 打开与关闭事件读取（从 `mesh-events.ts` 拆出，保持主文件在行数门禁内）。

import { openSignedSocket } from '@vibeterm/ws-client/socket-pop';
import type { MeshSocketLike } from './mesh-events';

export function closeCodeOf(event: unknown): number | null {
  const code = (event as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'number' ? code : null;
}

export function closeReasonOf(event: unknown): string {
  const reason = (event as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === 'string' ? reason : '';
}

/** `/mesh/ws` 同样受会话守卫：PoP 会话先签名再开（`pop` 查询参数），没有 PoP 会话时同步直开。 */
export function openMeshSocket(url: string): MeshSocketLike {
  const socket = openSignedSocket(url) as unknown as MeshSocketLike;
  socket.binaryType = 'arraybuffer';
  return socket;
}

export function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}
