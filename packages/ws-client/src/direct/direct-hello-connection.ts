// HELLO_S2C 用既有 capabilities 向量捎带本条 Gateway WS 的 connectionId。
// 加 Borsh 字段会让 2.3.0 壳解 HELLO 失败；未知能力串会被旧客户端忽略。

export const CONNECTION_ID_CAPABILITY_PREFIX = 'connection-id:';

export function formatConnectionIdCapability(connectionId: string): string {
  return `${CONNECTION_ID_CAPABILITY_PREFIX}${connectionId}`;
}

export function connectionIdFromCapabilities(
  capabilities: readonly string[] | null | undefined
): string | null {
  if (!capabilities) return null;
  for (const cap of capabilities) {
    if (!cap.startsWith(CONNECTION_ID_CAPABILITY_PREFIX)) continue;
    const id = cap.slice(CONNECTION_ID_CAPABILITY_PREFIX.length).trim();
    if (id) return id;
  }
  return null;
}
