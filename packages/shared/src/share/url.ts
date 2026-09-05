export function sharePath(shareId: string): string {
  return `/s/${shareId}`;
}

function normalizePrefix(prefix: string | null): string {
  if (!prefix) return '';
  const trimmed = prefix.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function nodeSharePrefix(nodeId: string): string {
  return `/n/${nodeId}`;
}

export function buildShareUrl(origin: string, nodePrefix: string | null, shareId: string): string {
  const base = origin.trim().replace(/\/+$/, '');
  return `${base}${normalizePrefix(nodePrefix)}${sharePath(shareId)}`;
}
