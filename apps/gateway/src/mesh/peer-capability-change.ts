export type PeerCapabilityFields = {
  version: string | null;
  directCapable: boolean;
  inventoryJson: string;
};

/**
 * version / directCapable / inventory 变化才是能力变化。
 * 端点集走 `peer-endpoint`，中继会话 hello 不是这个信号。
 */
export function peerCapabilitiesChanged(
  existing: PeerCapabilityFields | null | undefined,
  next: PeerCapabilityFields
): boolean {
  if (!existing) return false;
  return (
    (existing.version ?? null) !== next.version ||
    existing.directCapable !== next.directCapable ||
    existing.inventoryJson !== next.inventoryJson
  );
}
