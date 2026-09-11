/** 新鲜窗口 = 2 × `STUN_PROBE_INTERVAL_MS`（10 min）。 */
const STUN_PROBE_FRESH_MS = 2 * 10 * 60 * 1_000;

export type RankableStunProbe = {
  url: string;
  ok: boolean;
  rttMs: number;
  probedAt: number;
};

/** 新鲜成功的服务器按 RTT 提前；从未探测的保持原序；失败的只降权不丢弃。 */
export function rankStunByProbes(
  list: readonly string[],
  probes: readonly RankableStunProbe[],
  now: number
): string[] {
  const latest = new Map<string, RankableStunProbe>();
  for (const probe of probes) {
    const prev = latest.get(probe.url);
    if (!prev || probe.probedAt >= prev.probedAt) latest.set(probe.url, probe);
  }
  const ok: Array<{ url: string; rttMs: number; index: number }> = [];
  const never: string[] = [];
  const failed: string[] = [];
  for (let index = 0; index < list.length; index++) {
    const url = list[index];
    if (url === undefined) continue;
    const probe = latest.get(url);
    const fresh = probe != null && now - probe.probedAt <= STUN_PROBE_FRESH_MS;
    if (fresh && probe.ok) ok.push({ url, rttMs: probe.rttMs, index });
    else if (fresh) failed.push(url);
    else never.push(url);
  }
  ok.sort((a, b) => a.rttMs - b.rttMs || a.index - b.index);
  return [...ok.map((row) => row.url), ...never, ...failed];
}

export function stunListKey(urls: readonly string[]): string {
  return [...urls].sort().join('\0');
}
