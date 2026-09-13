// TURN 配置的扁平化：叶子模块，不能引 ice / probe（ice → ice-turn-pick 需要它，反向引会成环）。

import type { RelayTurnConfig } from '@vibeterm/shared/relay';
import { formatHostForIceUrl } from './stun-resolver';

/** 展平 object / array / string，按出现顺序去重。 */
export function flattenTurnConfigs(turn: unknown): RelayTurnConfig[] {
  const out: RelayTurnConfig[] = [];
  const seen = new Set<string>();
  walkTurnConfigs(turn, (hit) => {
    if (seen.has(hit.url)) return;
    seen.add(hit.url);
    out.push(hit);
  });
  return out;
}

export function configuredTurnUrls(turn: unknown): string[] {
  return flattenTurnConfigs(turn).map((row) => row.url);
}

function walkTurnConfigs(turn: unknown, emit: (hit: RelayTurnConfig) => void): void {
  if (typeof turn === 'string') {
    const url = nonempty(turn);
    if (url) emit({ url, username: '', credential: '' });
    return;
  }
  if (Array.isArray(turn)) {
    for (const item of turn) walkTurnConfigs(item, emit);
    return;
  }
  if (typeof turn !== 'object' || turn === null) return;
  walkTurnRecord(turn as Record<string, unknown>, emit);
}

function walkTurnRecord(rec: Record<string, unknown>, emit: (hit: RelayTurnConfig) => void): void {
  const username = typeof rec.username === 'string' ? rec.username : '';
  const credential =
    typeof rec.credential === 'string'
      ? rec.credential
      : typeof rec.password === 'string'
        ? rec.password
        : '';
  for (const url of urlsOfRecord(rec)) emit({ url, username, credential });
}

function nonempty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function urlsOfRecord(rec: Record<string, unknown>): string[] {
  if (typeof rec.hostname === 'string' && rec.hostname.length > 0) {
    const url = hostnameTurnUrl(rec);
    return url ? [url] : [];
  }
  if (typeof rec.url === 'string') {
    const url = nonempty(rec.url);
    if (url) return [url];
  }
  if (typeof rec.urls === 'string') {
    const url = nonempty(rec.urls);
    return url ? [url] : [];
  }
  if (Array.isArray(rec.urls)) return stringUrls(rec.urls);
  return [];
}

function stringUrls(items: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const url = nonempty(item);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function hostnameTurnUrl(rec: Record<string, unknown>): string | null {
  if (typeof rec.hostname !== 'string' || rec.hostname.length === 0) return null;
  const port = typeof rec.port === 'number' && Number.isFinite(rec.port) ? rec.port : 3478;
  const scheme = rec.relayType === 'TurnTls' ? 'turns' : 'turn';
  const host = formatHostForIceUrl(rec.hostname);
  const transport = rec.relayType === 'TurnTcp' ? '?transport=tcp' : '';
  return `${scheme}:${host}:${port}${transport}`;
}
