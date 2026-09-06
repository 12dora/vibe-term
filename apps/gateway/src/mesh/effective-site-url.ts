import type { SiteSettingsLinkProvider } from '../api/site-settings-link';
import { type MeshHubRecord, pickWriterHub } from '../auth/mesh-hub-store';

export type MeshHubUrlLookup = {
  list(): Array<
    Pick<MeshHubRecord, 'hubNodeId' | 'mode' | 'writerEpoch' | 'priority' | 'publicUrl'>
  >;
  get(hubNodeId: string): Pick<MeshHubRecord, 'publicUrl'> | null;
};

export type MeshSiteSettingsLinkInput = {
  roles: { hub: boolean; node: boolean; relay: boolean };
  localNodeId: () => string | null;
  hubStore: MeshHubUrlLookup | null;
  attachedHub: () => { publicUrl: string } | null;
  hubPublicUrl: string | null;
  hubMetaPublicUrl?: () => string | null;
  /** 上联种类；中继上联时站点 URL 不由 hub 托管（浏览器经中继访问要带 `/n/<self>`）。 */
  uplinkKind?: () => 'hub' | 'relay' | null;
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
  const relayUplink = () => (input.uplinkKind?.() ?? 'hub') === 'relay';
  const siteUrlManaged = () => input.roles.hub || (input.roles.node && !relayUplink());
  return {
    linked,
    siteUrlManaged,
    localNodeId: () => (linked() ? input.localNodeId() : null),
    effectiveSiteUrl() {
      if (!linked()) return null;
      const localId = input.localNodeId();
      if (input.roles.hub) {
        const own =
          (localId ? input.hubStore?.get(localId)?.publicUrl : null) || input.hubPublicUrl;
        if (own) return own;
      }
      // 中继上联时不存在可托管站点 URL 的 hub，存储值继续生效且可编辑。
      if (relayUplink()) return null;
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
