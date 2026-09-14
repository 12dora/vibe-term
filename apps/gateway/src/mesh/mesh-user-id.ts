import type { UserStore } from '../auth/user-store';

export function resolveMeshUserId(
  userStore: UserStore,
  opts?: { nodeId?: string | null; explicit?: string | null }
): string | null {
  if (opts?.explicit) return opts.explicit;
  if (opts?.nodeId) {
    const cert = userStore.getCert(opts.nodeId);
    if (cert?.userId) return cert.userId;
    const node = userStore.getNode(opts.nodeId);
    if (node?.userId) return node.userId;
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
  if (ids.size !== 1) return null;
  const only = ids.values().next().value;
  return typeof only === 'string' && only.length > 0 ? only : null;
}
