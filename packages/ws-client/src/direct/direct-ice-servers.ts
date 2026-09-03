import type { IceServerLike, RtcConfigResponse } from './rtc-types';

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === 'string' && value ? [value] : [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** `{stun, turn}` → `RTCConfiguration.iceServers`（turn 允许 string / {url|urls,…} / 数组）。 */
export function buildIceServers(config: RtcConfigResponse | null): IceServerLike[] {
  const servers: IceServerLike[] = [];
  for (const url of toStringArray(config?.stun)) servers.push({ urls: url });
  const turn = config?.turn;
  const entries = Array.isArray(turn) ? turn : turn == null ? [] : [turn];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry) servers.push({ urls: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const urls = toStringArray(rec.urls ?? rec.url);
    if (urls.length === 0) continue;
    const server: IceServerLike = { urls: urls.length === 1 ? (urls[0] as string) : urls };
    if (typeof rec.username === 'string') server.username = rec.username;
    if (typeof rec.credential === 'string') server.credential = rec.credential;
    servers.push(server);
  }
  return servers;
}
