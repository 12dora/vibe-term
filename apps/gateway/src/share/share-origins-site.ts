import { type ShareOriginCandidate, normalizeShareOrigin } from '@vibeterm/shared/share';

export function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** 真正会上榜的候选 origin；探测没过 / 当前不是中继上联的行不计入。 */
export function listedOriginsOf(items: readonly { url: string; listed: boolean }[]): Set<string> {
  const origins = new Set<string>();
  for (const item of items) {
    if (!item.listed) continue;
    const origin = originOf(item.url);
    if (origin) origins.add(origin);
  }
  return origins;
}

export function shouldOfferSite(
  site: string | null,
  listedOrigins: ReadonlySet<string>
): site is string {
  if (!site) return false;
  const origin = originOf(site);
  if (!origin) return false;
  return !listedOrigins.has(origin);
}

/** 前缀补上后 accessUrl 可能撞车（site 存的是中继 `/n/<id>`，中继候选 url 却是裸 origin）。同地址只留一条，自建域名让路。 */
export function uniqueByAccessUrl(candidates: ShareOriginCandidate[]): ShareOriginCandidate[] {
  const keyOf = (url: string) => normalizeShareOrigin(url) ?? url;
  const claimed = new Set(
    candidates.filter((item) => item.kind !== 'site').map((item) => keyOf(item.accessUrl))
  );
  const seen = new Set<string>();
  const unique: ShareOriginCandidate[] = [];
  for (const candidate of candidates) {
    const key = keyOf(candidate.accessUrl);
    if (seen.has(key)) continue;
    if (candidate.kind === 'site' && claimed.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}
