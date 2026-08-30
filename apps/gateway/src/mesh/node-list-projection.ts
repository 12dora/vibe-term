type Meta = {
  endpoints?: unknown;
  inventory?: unknown;
  directCapable?: boolean;
  version?: string | null;
};

export function parseJson(raw: string | null | undefined, fallback: unknown): unknown {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function versionFromInventory(inventory: unknown): string | null {
  if (!inventory || typeof inventory !== 'object' || !('version' in inventory)) return null;
  const value = (inventory as { version: unknown }).version;
  return value == null ? null : String(value);
}

export function projectNode(
  id: string,
  name: string,
  online: boolean,
  stored: Meta,
  live?: Meta | null
) {
  return {
    id,
    name,
    online,
    endpoints: live?.endpoints ?? stored.endpoints ?? [],
    inventory: live?.inventory ?? stored.inventory ?? null,
    direct_capable: live?.directCapable ?? stored.directCapable ?? false,
    version: live?.version ?? stored.version ?? null,
  };
}

export function upsertById<T extends { id: string }>(nodes: T[], entry: T): void {
  const existing = nodes.find((n) => n.id === entry.id);
  if (existing) Object.assign(existing, entry);
  else nodes.push(entry);
}

export function pickMeshNodeName(input: {
  id: string;
  isSelf: boolean;
  listedName?: string | null;
  registryName?: string | null;
  selfName?: string | null;
}): string {
  const usable = (name: string | null | undefined) => {
    const t = name?.trim() ?? '';
    return !t || t === input.id || t === 'self' ? null : t;
  };
  return (
    usable(input.listedName) ??
    usable(input.registryName) ??
    (input.isSelf ? usable(input.selfName) : null) ??
    (input.isSelf ? input.selfName?.trim() || 'self' : input.id)
  );
}
