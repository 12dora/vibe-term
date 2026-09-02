import type { SiteSettingsLinkProvider } from '../api/site-settings-link';
import { type MeshHubRecord, pickWriterHub } from '../auth/mesh-hub-store';

export type MeshHubUrlLookup = {
  list(): Array<
    Pick<MeshHubRecord, 'hubNodeId' | 'mode' | 'writerEpoch' | 'priority' | 'publicUrl'>
  >;
  get(hubNodeId: string): Pick<MeshHubRecord, 'publicUrl'> | null;
};

export type MeshSiteSettingsLinkInput = {
  roles: { hub: boolean; node: boolean };
  localNodeId: () => string | null;
  hubStore: MeshHubUrlLookup | null;
  attachedHub: () => { publicUrl: string } | null;
  hubPublicUrl: string | null;
  hubMetaPublicUrl?: () => string | null;
};

export type MeshHubUrlSelection = {
  hubNodeId: string | null;
  publicUrl: string | null;
};

/** writer.publicUrl ?? attached.publicUrl ?? config.hubPublicUrl ?? hub meta publicUrl */
export function resolveMeshHubSelection(input: {
  hubStore: MeshHubUrlLookup | null;
  attachedPublicUrl: string | null;
  hubPublicUrl: string | null;
  hubMetaPublicUrl?: string | null;
}): MeshHubUrlSelection {
  const rows = input.hubStore?.list() ?? [];
  const writerId = pickWriterHub(rows);
  if (writerId) {
    const writerUrl = input.hubStore?.get(writerId)?.publicUrl;
    if (writerUrl) return { hubNodeId: writerId, publicUrl: writerUrl };
  }
  if (input.attachedPublicUrl) {
    return { hubNodeId: writerId, publicUrl: input.attachedPublicUrl };
  }
  return {
    hubNodeId: writerId,
    publicUrl: input.hubPublicUrl ?? input.hubMetaPublicUrl ?? null,
  };
}

export function resolveMeshHubPublicUrl(input: {
  hubStore: MeshHubUrlLookup | null;
  attachedPublicUrl: string | null;
  hubPublicUrl: string | null;
  hubMetaPublicUrl?: string | null;
}): string | null {
  return resolveMeshHubSelection(input).publicUrl;
}

export function nodeAccessUrl(hubPublicUrl: string, nodeId: string): string {
  return `${hubPublicUrl.replace(/\/+$/, '')}/n/${nodeId}`;
}

export function createMeshSiteSettingsLink(
  input: MeshSiteSettingsLinkInput
): SiteSettingsLinkProvider {
  const linked = () => input.roles.hub || input.roles.node;
  return {
    linked,
    localNodeId: () => (linked() ? input.localNodeId() : null),
    effectiveSiteUrl() {
      if (!linked()) return null;
      const localId = input.localNodeId();
      if (input.roles.hub) {
        const own =
          (localId ? input.hubStore?.get(localId)?.publicUrl : null) || input.hubPublicUrl;
        if (own) return own;
      }
      const selected = resolveMeshHubSelection({
        hubStore: input.hubStore,
        attachedPublicUrl: input.attachedHub()?.publicUrl ?? null,
        hubPublicUrl: input.hubPublicUrl,
        hubMetaPublicUrl: input.hubMetaPublicUrl?.() ?? null,
      });
      if (!selected.publicUrl) return null;
      if (localId && selected.hubNodeId === localId) return selected.publicUrl;
      if (localId) return nodeAccessUrl(selected.publicUrl, localId);
      return input.roles.hub ? selected.publicUrl : null;
    },
  };
}
