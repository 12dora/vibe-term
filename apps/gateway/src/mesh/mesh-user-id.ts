import type { UserStore } from '../auth/user-store';

function userIdOfNode(userStore: UserStore, nodeId: string): string | null {
  return userStore.getCert(nodeId)?.userId ?? userStore.getNode(nodeId)?.userId ?? null;
}

function soleUserId(ids: Set<string>): string | null {
  if (ids.size !== 1) return null;
  const only = ids.values().next().value;
  return typeof only === 'string' && only.length > 0 ? only : null;
}

export function resolveMeshUserId(
  userStore: UserStore,
  opts?: { nodeId?: string | null; explicit?: string | null }
): string | null {
  if (opts?.explicit) return opts.explicit;
  if (opts?.nodeId) {
    const fromNode = userIdOfNode(userStore, opts.nodeId);
    if (fromNode) return fromNode;
  }
  const ids = new Set<string>();
  for (const user of userStore.listUsers()) {
    if (user.id) ids.add(user.id);
  }
  if (ids.size !== 1) {
    for (const cert of userStore.listCerts()) {
      if (cert.userId) ids.add(cert.userId);
    }
  }
  return soleUserId(ids);
}
