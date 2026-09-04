import type { MeshNodeRef, NodeTargetLookup, NodeTargetResult } from './command-types';

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function isSelfToken(input: string): boolean {
  const value = normalize(input);
  return value.length === 0 || value === 'self';
}

function only<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

function uniqueById(nodes: MeshNodeRef[]): MeshNodeRef[] {
  const seen = new Set<string>();
  const out: MeshNodeRef[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

export function resolveNodeTarget(
  input: string | undefined,
  lookup: NodeTargetLookup
): NodeTargetResult {
  const raw = input ?? '';
  const local: MeshNodeRef = {
    id: lookup.localNodeId,
    name: lookup.localName,
    online: true,
  };
  if (isSelfToken(raw)) {
    return { ok: true, node: local, local: true };
  }

  const nodes = uniqueById([local, ...lookup.nodes]);
  const exactId = nodes.find((node) => node.id === raw);
  if (exactId) {
    if (!exactId.online && exactId.id !== lookup.localNodeId) {
      return { ok: false, error: 'offline', input: raw, candidates: [exactId] };
    }
    return { ok: true, node: exactId, local: exactId.id === lookup.localNodeId };
  }

  const needle = normalize(raw);
  const nameMatches = nodes.filter((node) => normalize(node.name) === needle);
  const nameMatch = only(nameMatches);
  if (nameMatch) {
    if (!nameMatch.online && nameMatch.id !== lookup.localNodeId) {
      return { ok: false, error: 'offline', input: raw, candidates: [nameMatch] };
    }
    return { ok: true, node: nameMatch, local: nameMatch.id === lookup.localNodeId };
  }
  if (nameMatches.length > 1) {
    return { ok: false, error: 'ambiguous', input: raw, candidates: nameMatches };
  }

  const prefixMatches = nodes.filter((node) => {
    const id = node.id.toLowerCase();
    const name = normalize(node.name);
    return id.startsWith(needle) || name.startsWith(needle);
  });
  const prefixMatch = only(prefixMatches);
  if (prefixMatch) {
    if (!prefixMatch.online && prefixMatch.id !== lookup.localNodeId) {
      return { ok: false, error: 'offline', input: raw, candidates: [prefixMatch] };
    }
    return { ok: true, node: prefixMatch, local: prefixMatch.id === lookup.localNodeId };
  }
  if (prefixMatches.length > 1) {
    return { ok: false, error: 'ambiguous', input: raw, candidates: prefixMatches };
  }

  return { ok: false, error: 'unknown', input: raw };
}
