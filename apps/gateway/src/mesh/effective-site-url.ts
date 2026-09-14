import { isPublicShareOrigin, normalizeShareOrigin } from '@vibeterm/shared/share';
import type { SiteSettingsLinkProvider } from '../api/site-settings-link';

export type MeshSiteSettingsLinkInput = {
  roles: { node: boolean; relay: boolean };
  localNodeId: () => string | null;
  /** 上联种类；中继上联时站点 URL 走 `<relay>/n/<self>`。 */
  uplinkKind?: () => 'relay' | 'none';
  /** 存储的站点 URL；中继上联时用来判断用户是否已填了公网可达的自有域名。 */
  storedSiteUrl?: () => string | null;
  /** 中继上联时的实际访问地址 `<relay>/n/<self>`；入口未探通时为 null。 */
  relayAccessUrl?: () => string | null;
};

export function nodeAccessUrl(publicUrl: string, nodeId: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/n/${nodeId}`;
}

export function createMeshSiteSettingsLink(
  input: MeshSiteSettingsLinkInput
): SiteSettingsLinkProvider {
  const linked = () => input.roles.node;
  const relayUplink = () => (input.uplinkKind?.() ?? 'none') === 'relay';
  // 中继上联下站点 URL 不托管、可编辑，但通知深链仍要一个能点开的地址：
  // 存储值是公网地址就用它，否则（多数是种子回环地址）退回当前中继入口。
  const relayUplinkSiteUrl = (): string | null => {
    const stored = input.storedSiteUrl?.() ?? null;
    const normalized = stored ? normalizeShareOrigin(stored) : null;
    if (normalized && isPublicShareOrigin(normalized)) return stored;
    return input.relayAccessUrl?.() ?? null;
  };
  return {
    linked,
    localNodeId: () => (linked() ? input.localNodeId() : null),
    effectiveSiteUrl() {
      if (!linked()) return null;
      if (relayUplink()) return relayUplinkSiteUrl();
      return null;
    },
  };
}
