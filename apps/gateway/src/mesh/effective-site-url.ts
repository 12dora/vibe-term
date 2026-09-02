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

/** writer.publicUrl ?? attached.publicUrl ?? config.hubPublicUrl ?? hub meta publicUrl */
export function resolveMeshHubPublicUrl(input: {
  hubStore: MeshHubUrlLookup | null;
  attachedPublicUrl: string | null;
  hubPublicUrl: string | null;
  hubMetaPublicUrl?: string | null;
}): string | null {
  const rows = input.hubStore?.list() ?? [];
  const writerId = pickWriterHub(rows);
  if (writerId) {
    const writerUrl = input.hubStore?.get(writerId)?.publicUrl;
    if (writerUrl) return writerUrl;
  }
  if (input.attachedPublicUrl) return input.attachedPublicUrl;
  return input.hubPublicUrl ?? input.hubMetaPublicUrl ?? null;
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
      const hubUrl = resolveMeshHubPublicUrl({
        hubStore: input.hubStore,
        attachedPublicUrl: input.attachedHub()?.publicUrl ?? null,
        hubPublicUrl: input.hubPublicUrl,
        hubMetaPublicUrl: input.hubMetaPublicUrl?.() ?? null,
      });
      if (input.roles.hub) return hubUrl;
      const nodeId = input.localNodeId();
      if (hubUrl && nodeId) return nodeAccessUrl(hubUrl, nodeId);
      return null;
    },
  };
}
