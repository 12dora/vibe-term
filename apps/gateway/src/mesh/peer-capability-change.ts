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

const relayCapabilityChanges = new WeakMap<object, ReadonlySet<string>>();
const NO_CAPABILITY_CHANGES: ReadonlySet<string> = new Set();

/** `relay.list` 在写 `peer_cache` 之前记下的变化。名单对象本身不进协议。 */
export function tagRelayCapabilityChanges(list: object, ids: readonly string[]): void {
  if (ids.length === 0) return;
  relayCapabilityChanges.set(list, new Set(ids));
}

export function takeRelayCapabilityChanges(list: object): ReadonlySet<string> {
  const found = relayCapabilityChanges.get(list);
  if (!found) return NO_CAPABILITY_CHANGES;
  relayCapabilityChanges.delete(list);
  return found;
}
