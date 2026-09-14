import {
  ACCESS_BYPASS_PATH_PREFIXES,
  ACCESS_LEGACY_BYPASS_PATH_PREFIXES,
  bypassAppDomain,
  isManagedBypassAppName,
} from './access-paths';

export type BypassAppRef = { id: string; name: string; domain: string };

export function findManagedBypassApps<T extends BypassAppRef>(apps: T[], hostname: string): T[] {
  const host = hostname.toLowerCase();
  const prefixes = [...ACCESS_BYPASS_PATH_PREFIXES, ...ACCESS_LEGACY_BYPASS_PATH_PREFIXES];
  const wanted = prefixes.map((p) => bypassAppDomain(host, p).toLowerCase());
  const out: T[] = [];
  const seen = new Set<string>();
  for (const domain of wanted) {
    const hit =
      apps.find((a) => a.domain.toLowerCase() === domain) ??
      apps.find((a) => isManagedBypassAppName(a.name) && a.domain.toLowerCase() === domain);
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id);
      out.push(hit);
    }
  }
  return out;
}

type BypassClient = {
  listApps(accountId: string, apiToken: string): Promise<BypassAppRef[]>;
  deleteApp(accountId: string, apiToken: string, appId: string): Promise<void>;
};

/** 删除已存 id 以及按遗留前缀/托管名发现的 bypass 应用。list 失败时仍删已存 id。 */
export async function reapBypassApps(
  client: BypassClient,
  accountId: string,
  apiToken: string,
  hostname: string | null,
  existingIds: string[]
): Promise<void> {
  const ids = new Set(existingIds);
  if (hostname) {
    try {
      for (const app of findManagedBypassApps(
        await client.listApps(accountId, apiToken),
        hostname
      )) {
        ids.add(app.id);
      }
    } catch {
      /* 已存 id 仍要删 */
    }
  }
  for (const id of ids) await client.deleteApp(accountId, apiToken, id);
}

type BypassSyncClient = BypassClient & {
  upsertBypassApps(
    accountId: string,
    apiToken: string,
    hostname: string,
    existingIds: string[]
  ): Promise<string[]>;
};

export async function syncBypassAppIds(
  client: BypassSyncClient,
  input: {
    accountId: string;
    apiToken: string;
    hostname: string;
    currentIds: string[];
    hasMeshRole: boolean;
    step: (name: string) => void;
  }
): Promise<string[]> {
  if (ACCESS_BYPASS_PATH_PREFIXES.length > 0 && input.hasMeshRole) {
    input.step('bypass_app');
    return client.upsertBypassApps(
      input.accountId,
      input.apiToken,
      input.hostname,
      input.currentIds
    );
  }
  if (input.currentIds.length > 0 || input.hasMeshRole) {
    input.step('bypass_app');
    await reapBypassApps(client, input.accountId, input.apiToken, input.hostname, input.currentIds);
  }
  return [];
}
